import random
from collections import defaultdict
from datetime import datetime, timedelta

from services.data_source import (
    load_measurement_types,
    load_measurements,
    load_sensors,
    parse_bool as _parse_bool,
    parse_float as _parse_float,
    parse_time as _parse_time,
)


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


PROCESS_CODES = {
    "recipe_number",
    "segment_number",
    "total_segments",
    "time_remaining",
    "time_remaining_total",
}


def _get_measurement_type_map():
    rows = load_measurement_types()
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
    sensors = load_sensors()
    measurements = load_measurements()

    selected_sensor = next(
        (sensor for sensor in sensors if _parse_bool(sensor.get("enabled")) and sensor.get("name")),
        sensors[0] if sensors else {},
    )
    sensor_id = selected_sensor.get("id")

    sensor_lookup = {sensor.get("id"): sensor for sensor in sensors if sensor.get("id")}
    tank_stats = defaultdict(lambda: {"current_measured": [], "voltage_measured": []})
    tank_last_seen = {}
    process_values = defaultdict(dict)
    process_code_time = {}
    process_updated_at = {}

    for row in measurements:
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        code = measurement_type.get("code")
        if not code:
            continue

        sensor = sensor_lookup.get(row.get("sensor_id"))
        tank = (sensor.get("tank") if sensor else None) or "Inconnu"
        parsed_time = _parse_time(row.get("time"))

        if sensor and parsed_time:
            if tank not in tank_last_seen or parsed_time > tank_last_seen[tank]:
                tank_last_seen[tank] = parsed_time

        if code in {"current_measured", "voltage_measured"}:
            value = _parse_float(row.get("value_num"))
            if value is not None:
                if code == "current_measured":
                    value = value / 1000.0
                tank_stats[tank][code].append(value)

        if code in PROCESS_CODES and parsed_time:
            code_key = (tank, code)
            if code_key not in process_code_time or parsed_time > process_code_time[code_key]:
                process_code_time[code_key] = parsed_time
                process_values[tank][code] = row.get("value_num")
            if tank not in process_updated_at or parsed_time > process_updated_at[tank]:
                process_updated_at[tank] = parsed_time

    by_tank = []
    for tank_name, values in sorted(tank_stats.items()):
        by_tank.append(
            {
                "tank": tank_name,
                "current_measured": round(sum(values["current_measured"]) / len(values["current_measured"]), 2) if values["current_measured"] else 0,
                "voltage_measured": round(sum(values["voltage_measured"]) / len(values["voltage_measured"]), 2) if values["voltage_measured"] else 0,
            }
        )

    def _tank_process(tank_name):
        values = process_values.get(tank_name, {})
        updated_at = process_updated_at.get(tank_name)
        return {
            "recipe_number": values.get("recipe_number"),
            "segment_number": values.get("segment_number"),
            "total_segments": values.get("total_segments"),
            "time_remaining": values.get("time_remaining"),
            "time_remaining_total": values.get("time_remaining_total"),
            "updated_at": updated_at.isoformat() if updated_at else None,
        }

    per_tank_view = _build_tank_sensor_view(measurements, sensors, measurement_types)
    for view in per_tank_view:
        view["process"] = _tank_process(view["tank"])
        last_seen = tank_last_seen.get(view["tank"])
        view["last_seen"] = last_seen.isoformat() if last_seen else None

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
            "per_tank": per_tank_view,
        },
        "by_tank": by_tank,
        "sensors": [
            {
                "name": sensor.get("name") or "Capteur sans nom",
                "tank": sensor.get("tank") or "Inconnu",
                "is_auto": (sensor.get("name") or "").lower().startswith("auto"),
            }
            for sensor in sensors[:10]
        ],
    }
