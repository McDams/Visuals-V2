import csv
import random
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

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


def _parse_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() == "true"
    return False


def _sensor_base_value(sensor):
    name = (sensor.get("name") or "").strip().lower()
    if name.startswith("auto"):
        return 4.0
    if name.isdigit():
        return 3.8 + (int(name) % 4) * 0.12
    return 3.9


def _generate_random_series(sensor_id, center=4.0, count=6, deviation=0.18):
    rnd = random.Random(sensor_id)
    now = datetime.now()
    return [
        {
            "time": now - timedelta(seconds=(count - 1 - index) * 2),
            "value": round(center + rnd.uniform(-deviation, deviation), 2),
        }
        for index in range(count)
    ]


def _get_measurement_type_map():
    rows = _load_csv("measurement_types.csv")
    return {row["id"]: row for row in rows}


def _build_series(rows, sensors, measurement_types, code, group_mode):
    grouped = defaultdict(list)
    sensor_lookup = {sensor.get("id"): sensor for sensor in sensors if sensor.get("id")}

    for row in rows:
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        if measurement_type.get("code") != code:
            continue

        parsed_time = _parse_time(row.get("time"))
        value = _parse_float(row.get("value_num"))
        if parsed_time is None or value is None:
            continue
        if code == "current_measured":
            value = value / 1000.0

        sensor = sensor_lookup.get(row.get("sensor_id"), {})
        if group_mode == "tank": 
            group = sensor.get("tank") or "Inconnu"
        elif group_mode == "automation":
            name = (sensor.get("name") or "").lower()
            group = "Automates" if "auto" in name else "Capteurs"
        else:
            group = sensor.get("name") or sensor.get("id") or "Inconnu"

        grouped[group].append({"time": parsed_time, "value": value})

    result = []
    for label, values in sorted(grouped.items()):
        values = sorted(values, key=lambda item: item["time"])
        if len(values) > 80:
            values = values[:: max(1, len(values) // 60)]
        result.append(
            {
                "label": label,
                "points": [
                    {
                        "time": item["time"].strftime("%H:%M:%S"),
                        "value": round(item["value"], 2),
                    }
                    for item in values
                ],
            }
        )
    return result


def _select_tank_sensors(tank_sensors):
    manual_sensors = [
        sensor for sensor in tank_sensors if not (sensor.get("name") or "").lower().startswith("auto")
    ]
    auto_sensors = [
        sensor for sensor in tank_sensors if (sensor.get("name") or "").lower().startswith("auto")
    ]

    manual_sorted = sorted(
        manual_sensors,
        key=lambda sensor: (
            int(sensor.get("display_order")) if sensor.get("display_order") and sensor.get("display_order").isdigit() else 0,
            sensor.get("name") or "",
        ),
    )
    auto_sorted = sorted(
        auto_sensors,
        key=lambda sensor: (
            int(sensor.get("display_order")) if sensor.get("display_order") and sensor.get("display_order").isdigit() else 0,
            sensor.get("name") or "",
        ),
    )

    selected = manual_sorted[:4]
    if len(selected) < 4:
        selected.extend(auto_sorted[: 4 - len(selected)])
    return selected[:4]


def _build_tank_sensor_view(rows, sensors, measurement_types):
    # Count current measurement coverage per sensor so we can prioritize the sensors that have data.
    current_counts = defaultdict(int)
    for row in rows:
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        if measurement_type.get("code") != "current_measured":
            continue
        sensor_id = row.get("sensor_id")
        if sensor_id:
            current_counts[sensor_id] += 1

    tanks = sorted({sensor.get("tank") for sensor in sensors if sensor.get("tank")})
    view = []

    for tank in tanks:
        tank_sensors = [sensor for sensor in sensors if (sensor.get("tank") or "") == tank and sensor.get("id")]
        if not tank_sensors:
            continue

        automation = next((sensor for sensor in tank_sensors if (sensor.get("name") or "").lower().startswith("auto")), None)
        manual_sensors = [sensor for sensor in tank_sensors if not (sensor.get("name") or "").lower().startswith("auto")]

        selected_sensors = sorted(
            manual_sensors,
            key=lambda sensor: (
                -current_counts.get(sensor["id"], 0),
                int(sensor.get("display_order")) if sensor.get("display_order") and sensor.get("display_order").isdigit() else 0,
                sensor.get("name") or sensor.get("id") or "",
            ),
        )[:4]

        series_map = {sensor["id"]: [] for sensor in selected_sensors}
        if automation:
            series_map[automation["id"]] = []

        for row in rows:
            sensor_id = row.get("sensor_id")
            if sensor_id not in series_map:
                continue

            measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
            if measurement_type.get("code") != "current_measured":
                continue

            parsed_time = _parse_time(row.get("time"))
            value = _parse_float(row.get("value_num"))
            if parsed_time is None or value is None:
                continue
            value = value / 1000.0

            series_map[sensor_id].append({"time": parsed_time, "value": value})

        for sensor in selected_sensors:
            if not series_map[sensor["id"]]:
                series_map[sensor["id"]] = _generate_random_series(sensor["id"], center=_sensor_base_value(sensor))

        if automation and not series_map[automation["id"]]:
            center = 4.0
            if selected_sensors and series_map[selected_sensors[0]["id"]]:
                center = series_map[selected_sensors[0]["id"]][-1]["value"]
            series_map[automation["id"]] = _generate_random_series(automation["id"], center=center)

        series = [
            {
                "label": sensor.get("name") or sensor.get("id") or "Capteur inconnu",
                "points": [
                    {
                        "time": item["time"].strftime("%H:%M:%S"),
                        "value": round(item["value"], 2),
                    }
                    for item in sorted(series_map[sensor["id"]], key=lambda item: item["time"])
                ],
            }
            for sensor in selected_sensors
        ]

        if automation:
            series.append(
                {
                    "label": automation.get("name") or "Automate",
                    "points": [
                        {
                            "time": item["time"].strftime("%H:%M:%S"),
                            "value": round(item["value"], 2),
                        }
                        for item in sorted(series_map[automation["id"]], key=lambda item: item["time"])
                    ],
                }
            )

        view.append(
            {
                "tank": tank,
                "automation": automation.get("name") if automation else None,
                "title": f"{tank} / {automation.get('name') if automation else 'Aucun automate'}",
                "sensors": [sensor.get("name") or sensor.get("id") or "Capteur inconnu" for sensor in selected_sensors],
                "series": series,
            }
        )

    return view


def get_dashboard_payload():
    measurement_types = _get_measurement_type_map()
    sensors = _load_csv("sensors.csv")
    measurements = _load_csv("measurements.csv")

    selected_sensor = next(
        (sensor for sensor in sensors if _parse_bool(sensor.get("enabled")) and sensor.get("name")),
        sensors[0] if sensors else {},
    )
    sensor_id = selected_sensor.get("id")

    process_state = {}
    tank_stats = defaultdict(lambda: {"current_measured": [], "voltage_measured": []})

    for row in measurements:
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        code = measurement_type.get("code")
        if not code:
            continue

        if row.get("sensor_id") and code in {"current_measured", "voltage_measured"}:
            sensor = next((item for item in sensors if item.get("id") == row.get("sensor_id")), None)
            if sensor:
                tank = sensor.get("tank") or "Inconnu"
                value = _parse_float(row.get("value_num"))
                if value is not None:
                    if code == "current_measured":
                        value = value / 1000.0
                    tank_stats[tank][code].append(value)

        if code in {"recipe_number", "segment_number", "total_segments", "time_remaining", "time_remaining_total"}:
            parsed_time = _parse_time(row.get("time"))
            value = row.get("value_num")
            if parsed_time:
                process_state[code] = {
                    "time": parsed_time,
                    "value": value,
                }

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
            "automates_count": len([sensor for sensor in sensors if _parse_bool(sensor.get("enabled")) and (sensor.get("name") or "").lower().startswith("auto")]),
            "manual_sensor_count": len([sensor for sensor in sensors if _parse_bool(sensor.get("enabled")) and not (sensor.get("name") or "").lower().startswith("auto")]),
        },
        "timeline": [
            {
                "label": "Courant mesuré",
                "points": [
                    {
                        "time": item["time"].strftime("%H:%M:%S"),
                        "value": round(item["value"], 2),
                    }
                    for item in sorted(
                        [
                            {
                                "time": _parse_time(row.get("time")),
                                "value": (_parse_float(row.get("value_num")) / 1000.0) if _parse_float(row.get("value_num")) is not None else None,
                            }
                            for row in measurements
                            if measurement_types.get(row.get("measurement_type_id"), {}).get("code") == "current_measured"
                            and row.get("sensor_id") == sensor_id
                            and _parse_time(row.get("time")) is not None
                            and _parse_float(row.get("value_num")) is not None
                        ],
                        key=lambda item: item["time"],
                    )
                ],
            }
        ],
        "live_charts": {
            "by_tank": {
                "current": _build_series(measurements, sensors, measurement_types, "current_measured", "tank"),
                "voltage": _build_series(measurements, sensors, measurement_types, "voltage_measured", "tank"),
            },
            "by_automation": {
                "current": _build_series(measurements, sensors, measurement_types, "current_measured", "automation"),
            },
            "by_sensor": {
                "current": _build_series(measurements, sensors, measurement_types, "current_measured", "sensor"),
            },
            "per_tank": _build_tank_sensor_view(measurements, sensors, measurement_types),
        },
        "by_tank": by_tank,
        "latest_process": latest_process,
        "sensors": [
            {
                "name": sensor.get("name") or "Capteur sans nom",
                "tank": sensor.get("tank") or "Inconnu",
                "is_auto": (sensor.get("name") or "").lower().startswith("auto"),
            }
            for sensor in sensors[:10]
        ],
    }
