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
from services.tank_config import (
    CURRENT_CODES,
    IMBALANCE_THRESHOLD_A,
    OVERCURRENT_THRESHOLD_A,
    PH_MAX,
    PH_MEASUREMENT_CODE,
    PH_MIN,
    SENSOR_STALE_SECONDS,
)


def get_alerts(threshold_current=OVERCURRENT_THRESHOLD_A):
    """Construit la liste des alertes actives à partir de la source de données courante.

    Types d'alertes : courant élevé par cuve, capteurs sans données récentes, cuve à l'arrêt,
    écart de courant (par capteur et par côté), dépassement de temps de production, pH.
    """
    # measurement_types indexé par id pour retrouver le "code" d'une mesure.
    measurement_types = {row["id"]: row for row in load_measurement_types()}
    sensors = load_sensors()
    measurements = load_measurements()

    sensor_lookup = {s.get("id"): s for s in sensors}

    # tank_currents : valeurs de courant par cuve (pour la moyenne).
    # last_seen : dernier horodatage vu par capteur (pour l'alerte "pas de données récentes").
    tank_currents = defaultdict(list)
    last_seen = defaultdict(lambda: None)

    for row in measurements:
        mt = measurement_types.get(row.get("measurement_type_id"), {})
        code = mt.get("code")
        val = _parse_float(row.get("value_num"))
        if val is None:
            continue
        if code in CURRENT_CODES:
            val = val / 1000.0  # milli-unités -> ampères
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

    # --- Courant moyen élevé par cuve ---
    for tank, currents in tank_currents.items():
        if not currents:
            continue
        avg = sum(currents) / len(currents)
        if avg >= threshold_current:
            alerts.append({
                "tank": tank,
                "severity": "major",
                "message": f"Courant élevé : {round(avg)} A",
                "metric": "current",
                "value": round(avg, 2),
            })

    # --- Capteurs sans données récentes (dernière mesure > SENSOR_STALE_SECONDS) ---
    now = datetime.now()
    for s in sensors:
        sid = s.get("id")
        ls = last_seen.get(sid)
        if ls is None or (now - ls).total_seconds() > SENSOR_STALE_SECONDS:
            alerts.append({
                "sensor": s.get("name") or sid,
                "tank": s.get("tank"),
                "severity": "minor",
                "message": "Pas de données récentes",
                "last_seen": ls.isoformat() if ls else None,
            })

    # --- Alertes au niveau cuve, dérivées de la vue enrichie (statut, équilibre, job) ---
    for view in get_tank_views():
        tank = view["tank"]

        # Cuve entièrement à l'arrêt.
        if view.get("status") == "arret":
            alerts.append({
                "tank": tank,
                "severity": "major",
                "message": "À l'arrêt",
                "metric": "status",
                "alert_type": "Arrêt Programmé",
            })

        # Écart de courant, vérifié à deux niveaux : chaque capteur par rapport à la moyenne de
        # la cuve, et chaque côté par rapport à sa propre moyenne gauche/droite (un capteur peut
        # être dans la tolérance de toute la cuve mais nettement décalé de son partenaire de côté).
        manual_series = [s for s in view.get("series", []) if not s.get("isAutomate")]
        latest_values = [
            {"label": s["label"], "value": s["points"][-1]["value"]}
            for s in manual_series
            if s.get("points")
        ]
        if len(latest_values) >= 2:
            avg = sum(item["value"] for item in latest_values) / len(latest_values)
            # Une alerte par capteur dépassant le seuil (pas seulement le pire).
            for item in latest_values:
                deviation = abs(item["value"] - avg)
                if deviation > IMBALANCE_THRESHOLD_A:
                    alerts.append({
                        "tank": tank,
                        "severity": "minor",
                        "message": f"Écart de {round(deviation, 1)} A — capteur {item['label']}",
                        "metric": "current_imbalance",
                        "alert_type": "Écart Ampérage",
                    })

        # Écart interne à un côté (gauche/droite) : le tableau de nœud fournit déjà le "delta"
        # de chaque capteur par rapport à la moyenne de son côté et un drapeau "balanced".
        for side, side_label in (("left", "Noeud Gauche"), ("right", "Noeud Droite")):
            node = (view.get("nodes") or {}).get(side)
            if not node or node.get("balanced") is not False:
                continue
            for sensor_item in node.get("sensors", []):
                delta = sensor_item.get("delta")
                if delta is not None and abs(delta) > IMBALANCE_THRESHOLD_A:
                    alerts.append({
                        "tank": tank,
                        "severity": "minor",
                        "message": f"Écart {side_label} de {round(abs(delta), 1)} A — capteur {sensor_item['name']}",
                        "metric": "node_imbalance",
                        "alert_type": "Écart Ampérage",
                    })

        # Dépassement de la durée attendue du job en cours.
        job = view.get("job")
        if job and job.get("overrun"):
            alerts.append({
                "tank": tank,
                "severity": "major",
                "message": f"Job {job['name']} dépassé : {job['elapsed_hours']} h / {job['max_hours']} h",
                "metric": "job_duration",
                "alert_type": "Temps de production",
            })

    # --- Surveillance pH : inactive tant que PH_MEASUREMENT_CODE / PH_MIN / PH_MAX ne sont pas
    # renseignés dans tank_config.py (aucun code pH dans le schéma/les données de démo). ---
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
            # On ne garde que la dernière valeur de pH par cuve.
            if tank not in ph_latest or t > ph_latest[tank]["time"]:
                ph_latest[tank] = {"time": t, "value": val}

        for tank, data in ph_latest.items():
            if not (PH_MIN <= data["value"] <= PH_MAX):
                alerts.append({
                    "tank": tank,
                    "severity": "major",
                    "message": f"pH hors plage : {data['value']}",
                    "metric": "ph",
                    "alert_type": "Alerte pH",
                })

    # Tri (majeures d'abord, puis par cuve) et plafond à 30 alertes.
    alerts = sorted(alerts, key=lambda a: (a.get("severity") != "major", a.get("tank") or ""))[:30]
    return alerts
