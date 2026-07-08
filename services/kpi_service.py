from collections import defaultdict

from services.data_source import (
    load_measurement_types,
    load_measurements,
    load_sensors,
    parse_float as _parse_float,
    parse_time as _parse_time,
)


def get_kpis():
    measurement_types = {row["id"]: row for row in load_measurement_types()}
    sensors = load_sensors()
    measurements = load_measurements()

    enabled_sensors = [s for s in sensors if str(s.get("enabled")).lower() == "true"]

    # Aggregate simple KPIs
    temp_values = []
    current_values = []
    tank_map = defaultdict(
        lambda: {
            "current": [],
            "voltage": [],
            "sensors": set(),
            "last_seen": None,
            "latest_current": None,
            "latest_current_time": None,
            "latest_voltage": None,
            "latest_voltage_time": None,
        }
    )

    sensor_lookup = {s.get("id"): s for s in sensors}

    for row in measurements:
        mt = measurement_types.get(row.get("measurement_type_id"), {})
        code = mt.get("code")
        val = _parse_float(row.get("value_num"))
        if val is None:
            continue

        sensor = sensor_lookup.get(row.get("sensor_id"))
        tank = (sensor.get("tank") if sensor else None) or "Inconnu"
        t = _parse_time(row.get("time"))

        if code == "temperature":
            temp_values.append(val)
        if code == "current_measured":
            # measurements are in milli-units in CSV; convert to A
            amps = val / 1000.0
            current_values.append(amps)
            tank_map[tank]["current"].append(amps)
            if t and (tank_map[tank]["latest_current_time"] is None or t > tank_map[tank]["latest_current_time"]):
                tank_map[tank]["latest_current_time"] = t
                tank_map[tank]["latest_current"] = amps
        if code == "voltage_measured":
            tank_map[tank]["voltage"].append(val)
            if t and (tank_map[tank]["latest_voltage_time"] is None or t > tank_map[tank]["latest_voltage_time"]):
                tank_map[tank]["latest_voltage_time"] = t
                tank_map[tank]["latest_voltage"] = val

        if sensor:
            tank_map[tank]["sensors"].add(sensor.get("id"))

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
                "latest_current": round(data["latest_current"], 2) if data["latest_current"] is not None else None,
                "latest_voltage": round(data["latest_voltage"], 2) if data["latest_voltage"] is not None else None,
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
