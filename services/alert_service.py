from collections import defaultdict
from datetime import datetime

from services.data_source import (
    load_measurement_types,
    load_measurements,
    load_sensors,
    parse_float as _parse_float,
    parse_time as _parse_time,
)


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
        if code == "current_measured":
            val = val / 1000.0
        sensor = sensor_lookup.get(row.get("sensor_id"))
        tank = (sensor.get("tank") if sensor else None) or "Inconnu"

        if code == "current_measured":
            tank_currents[tank].append(val)

        t = _parse_time(row.get("time"))
        if t:
            # normalize timezone: prefer naive datetimes for comparison with now()
            if getattr(t, 'tzinfo', None) is not None:
                t = t.replace(tzinfo=None)
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
            })

    # cap results
    alerts = sorted(alerts, key=lambda a: (a.get("severity") != "major", a.get("tank") or ""))[:30]
    return alerts
