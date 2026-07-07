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


def get_kpis():
    measurement_types = {row["id"]: row for row in _load_csv("measurement_types.csv")}
    sensors = _load_csv("sensors.csv")
    measurements = _load_csv("measurements.csv")

    enabled_sensors = [s for s in sensors if str(s.get("enabled")).lower() == "true"]

    # Aggregate simple KPIs
    temp_values = []
    current_values = []
    tank_map = defaultdict(lambda: {"current": [], "voltage": [], "sensors": set(), "last_seen": None})

    sensor_lookup = {s.get("id"): s for s in sensors}

    for row in measurements:
        mt = measurement_types.get(row.get("measurement_type_id"), {})
        code = mt.get("code")
        val = _parse_float(row.get("value_num"))
        if val is None:
            continue

        sensor = sensor_lookup.get(row.get("sensor_id"))
        tank = (sensor.get("tank") if sensor else None) or "Inconnu"

        if code == "temperature":
            temp_values.append(val)
        if code == "current_measured":
            # measurements are in milli-units in CSV; convert to A
            current_values.append(val / 1000.0)
            tank_map[tank]["current"].append(val / 1000.0)
        if code == "voltage_measured":
            tank_map[tank]["voltage"].append(val)

        if sensor:
            tank_map[tank]["sensors"].add(sensor.get("id"))

        t = _parse_time(row.get("time"))
        if t:
            last = tank_map[tank]["last_seen"]
            if not last or t > last:
                tank_map[tank]["last_seen"] = t

    per_tank = []
    for tank, data in sorted(tank_map.items()):
        per_tank.append(
            {
                "tank": tank,
                "avg_current": round(sum(data["current"]) / len(data["current"]), 2) if data["current"] else 0,
                "avg_voltage": round(sum(data["voltage"]) / len(data["voltage"]), 2) if data["voltage"] else 0,
                "sensor_count": len(data["sensors"]),
                "last_seen": data["last_seen"].isoformat() if data["last_seen"] else None,
            }
        )

    return {
        "temperature_moyenne": round(sum(temp_values) / len(temp_values), 2) if temp_values else None,
        "courant_moyen": round(sum(current_values) / len(current_values), 2) if current_values else None,
        "nombre_cuves": len({s.get("tank") for s in enabled_sensors if s.get("tank")} ),
        "nombre_capteurs": len(enabled_sensors),
        "per_tank": per_tank,
    }
