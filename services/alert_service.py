import csv
from collections import defaultdict
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(__file__).resolve().parent.parent
DB_DIR = BASE_DIR / "db"


def _load_csv(filename):
    with (DB_DIR / filename).open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        for key, value in row.items():
            if isinstance(value, str) and value.strip().upper() == "NULL":
                row[key] = None
    return rows


def _parse_float(value):
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def get_alerts(threshold_current=4.7):
    """Return a list of simple alerts derived from the CSV snapshot.

    Alerts include over-current per tank and sensors without recent data.
    """
    measurement_types = {row["id"]: row for row in _load_csv("measurement_types.csv")}
    sensors = _load_csv("sensors.csv")
    measurements = _load_csv("measurements.csv")

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
