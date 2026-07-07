import csv
from collections import defaultdict
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DB_DIR = BASE_DIR / "db"


def _load_csv(filename):
    with (DB_DIR / filename).open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


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


def _parse_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() == "true"
    return False


def _get_measurement_type_map():
    rows = _load_csv("measurement_types.csv")
    return {row["id"]: row for row in rows}


def get_dashboard_payload():
    measurement_types = _get_measurement_type_map()
    sensors = _load_csv("sensors.csv")
    measurements = _load_csv("measurements.csv")

    selected_sensor = next(
        (sensor for sensor in sensors if _parse_bool(sensor.get("enabled")) and sensor.get("name")),
        sensors[0] if sensors else {},
    )
    sensor_id = selected_sensor.get("id")

    relevant_codes = {"current_measured", "voltage_measured", "current_setpoint", "voltage_setpoint"}
    relevant_measurement_ids = {
        row["id"]
        for row in measurement_types.values()
        if row.get("code") in relevant_codes
    }

    series = defaultdict(list)
    process_state = {}
    tank_stats = defaultdict(lambda: {"current_measured": [], "voltage_measured": []})

    for row in measurements:
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        code = measurement_type.get("code")
        if not code:
            continue

        if row.get("sensor_id") == sensor_id and code in relevant_codes:
            parsed_time = _parse_time(row.get("time"))
            value = _parse_float(row.get("value_num"))
            if parsed_time and value is not None:
                series[code].append({"time": parsed_time, "value": value})

        if row.get("sensor_id") and code in {"current_measured", "voltage_measured"}:
            sensor = next((item for item in sensors if item.get("id") == row.get("sensor_id")), None)
            if sensor:
                tank = sensor.get("tank") or "Inconnu"
                if value := _parse_float(row.get("value_num")):
                    tank_stats[tank][code].append(value)

        if code in {"recipe_number", "segment_number", "total_segments", "time_remaining", "time_remaining_total"}:
            parsed_time = _parse_time(row.get("time"))
            value = row.get("value_num")
            if parsed_time:
                process_state[code] = {
                    "time": parsed_time,
                    "value": value,
                }

    timeline = []
    for code in ["current_measured", "current_setpoint", "voltage_measured", "voltage_setpoint"]:
        values = sorted(series.get(code, []), key=lambda item: item["time"])
        if len(values) > 80:
            values = values[:: max(1, len(values) // 60)]
        timeline.append(
            {
                "label": code.replace("_", " ").title(),
                "points": [
                    {
                        "time": item["time"].strftime("%H:%M:%S"),
                        "value": round(item["value"], 2),
                    }
                    for item in values
                ],
            }
        )

    by_tank = []
    for tank_name, values in sorted(tank_stats.items()):
        by_tank.append(
            {
                "tank": tank_name,
                "current_measured": round(sum(values["current_measured"]) / len(values["current_measured"]), 2) if values["current_measured"] else 0,
                "voltage_measured": round(sum(values["voltage_measured"]) / len(values["voltage_measured"]), 2) if values["voltage_measured"] else 0,
            }
        )

    latest_process = {
        "recipe_number": process_state.get("recipe_number", {}).get("value"),
        "segment_number": process_state.get("segment_number", {}).get("value"),
        "total_segments": process_state.get("total_segments", {}).get("value"),
        "time_remaining": process_state.get("time_remaining", {}).get("value"),
        "time_remaining_total": process_state.get("time_remaining_total", {}).get("value"),
    }

    return {
        "summary": {
            "active_tanks": len({sensor.get("tank") for sensor in sensors if _parse_bool(sensor.get("enabled")) and sensor.get("tank")}),
            "sensor_count": len([sensor for sensor in sensors if _parse_bool(sensor.get("enabled"))]),
            "measurement_points": len(measurements),
            "selected_sensor": selected_sensor.get("name") or selected_sensor.get("id"),
        },
        "timeline": timeline,
        "by_tank": by_tank,
        "latest_process": latest_process,
        "sensors": [
            {
                "name": sensor.get("name") or "Capteur sans nom",
                "tank": sensor.get("tank") or "Inconnu",
            }
            for sensor in sensors[:10]
        ],
    }
