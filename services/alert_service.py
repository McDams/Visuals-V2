from collections import defaultdict
from datetime import datetime

from services.chart_service import get_tank_views
from services.data_source import (
    load_measurement_types,
    load_measurements,
    load_sensors,
    parse_float as _parse_float,
    parse_time as _parse_time,
)
from services.tank_config import CURRENT_CODES, IMBALANCE_THRESHOLD_A, PH_MAX, PH_MEASUREMENT_CODE, PH_MIN


def get_alerts(threshold_current=4.7):
    """Return a list of simple alerts derived from the current data source.

    Alerts include over-current per tank and sensors without recent data.
    """
    measurement_types = {row["id"]: row for row in load_measurement_types()}
    sensors = load_sensors()
    measurements = load_measurements()

    sensor_lookup = {s.get("id"): s for s in sensors}

    tank_currents = defaultdict(list)
    last_seen = defaultdict(lambda: None)

    for row in measurements:
        mt = measurement_types.get(row.get("measurement_type_id"), {})
        code = mt.get("code")
        val = _parse_float(row.get("value_num"))
        if val is None:
            continue
        if code in CURRENT_CODES:
            val = val / 1000.0
        sensor = sensor_lookup.get(row.get("sensor_id"))
        tank = (sensor.get("tank") if sensor else None) or "Inconnu"

        if code in CURRENT_CODES:
            tank_currents[tank].append(val)

        t = _parse_time(row.get("time"))
        if t:
            key = sensor.get("id") if sensor else row.get("sensor_id")
            if not last_seen[key] or t > last_seen[key]:
                last_seen[key] = t

    alerts = []

    # Over-current per tank
    for tank, currents in tank_currents.items():
        if not currents:
            continue
        avg = sum(currents) / len(currents)
        if avg >= threshold_current:
            alerts.append({
                "tank": tank,
                "severity": "major",
                "message": f"Courant moyen élevé ({round(avg,2)} A) dans la cuve {tank}",
                "metric": "current",
                "value": round(avg, 2),
            })

    # Sensors without recent data (last seen more than 10 seconds ago)
    now = datetime.now()
    for s in sensors:
        sid = s.get("id")
        ls = last_seen.get(sid)
        if ls is None or (now - ls).total_seconds() > 20:
            alerts.append({
                "sensor": s.get("name") or sid,
                "tank": s.get("tank"),
                "severity": "minor",
                "message": "Pas de données récentes",
                "last_seen": ls.isoformat() if ls else None,
            })

    # Tank-level alerts derived from the enriched per-tank view (status, node balance, job).
    for view in get_tank_views():
        tank = view["tank"]

        if view.get("status") == "arret":
            alerts.append({
                "tank": tank,
                "severity": "major",
                "message": f"Cuve {tank} à l'arrêt (courant < 10A depuis plus de 60s)",
                "metric": "status",
                "alert_type": "Arrêt Programmé",
            })

        manual_series = [s for s in view.get("series", []) if not s.get("isAutomate")]
        latest_values = [
            {"label": s["label"], "value": s["points"][-1]["value"]}
            for s in manual_series
            if s.get("points")
        ]
        if len(latest_values) >= 2:
            avg = sum(item["value"] for item in latest_values) / len(latest_values)
            worst = max(latest_values, key=lambda item: abs(item["value"] - avg))
            deviation = abs(worst["value"] - avg)
            if deviation > IMBALANCE_THRESHOLD_A:
                alerts.append({
                    "tank": tank,
                    "severity": "minor",
                    "message": f"Écart de courant de {round(deviation, 1)} A sur le capteur {worst['label']} par rapport à la moyenne de la cuve {tank} ({round(avg, 1)} A)",
                    "metric": "current_imbalance",
                    "alert_type": "Écart Ampérage",
                })

        job = view.get("job")
        if job and job.get("overrun"):
            alerts.append({
                "tank": tank,
                "severity": "major",
                "message": f"Job {job['name']} en cours sur {tank} depuis {job['elapsed_hours']} h (durée attendue : {job['max_hours']} h)",
                "metric": "job_duration",
                "alert_type": "Temps de production",
            })

    # pH monitoring: inactive until PH_MEASUREMENT_CODE / PH_MIN / PH_MAX are set in
    # services/tank_config.py (no ph measurement code exists in the current schema/demo data).
    if PH_MEASUREMENT_CODE is not None and PH_MIN is not None and PH_MAX is not None:
        ph_latest = {}
        for row in measurements:
            mt = measurement_types.get(row.get("measurement_type_id"), {})
            if mt.get("code") != PH_MEASUREMENT_CODE:
                continue
            val = _parse_float(row.get("value_num"))
            t = _parse_time(row.get("time"))
            if val is None or t is None:
                continue
            sensor = sensor_lookup.get(row.get("sensor_id"))
            tank = (sensor.get("tank") if sensor else None) or "Inconnu"
            if tank not in ph_latest or t > ph_latest[tank]["time"]:
                ph_latest[tank] = {"time": t, "value": val}

        for tank, data in ph_latest.items():
            if not (PH_MIN <= data["value"] <= PH_MAX):
                alerts.append({
                    "tank": tank,
                    "severity": "major",
                    "message": f"pH hors plage sur la cuve {tank} ({data['value']}, attendu {PH_MIN}-{PH_MAX})",
                    "metric": "ph",
                    "alert_type": "Alerte pH",
                })

    # cap results
    alerts = sorted(alerts, key=lambda a: (a.get("severity") != "major", a.get("tank") or ""))[:30]
    return alerts
