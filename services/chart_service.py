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
from services.tank_config import (
    IMBALANCE_THRESHOLD_A,
    JOBS,
    STOP_CURRENT_THRESHOLD_A,
    STOP_DURATION_SECONDS,
    get_node,
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


def _node_stopped(sensor_ids, series_map, threshold=STOP_CURRENT_THRESHOLD_A, stop_seconds=STOP_DURATION_SECONDS):
    """Return True if every sensor in sensor_ids has been below threshold for longer than
    stop_seconds, False if at least one is currently active, or None if there is no data."""
    latest_time = None
    latest_active_time = None
    currently_active = False

    for sensor_id in sensor_ids:
        points = series_map.get(sensor_id) or []
        if not points:
            continue
        last_point = points[-1]
        if latest_time is None or last_point["time"] > latest_time:
            latest_time = last_point["time"]
        if last_point["value"] >= threshold:
            currently_active = True
        for point in points:
            if point["value"] >= threshold and (latest_active_time is None or point["time"] > latest_active_time):
                latest_active_time = point["time"]

    if latest_time is None:
        return None
    if currently_active:
        return False
    if latest_active_time is None:
        return True
    return (latest_time - latest_active_time).total_seconds() > stop_seconds


def _tank_status(left_ids, right_ids, all_manual_ids, series_map):
    if left_ids or right_ids:
        left_stopped = _node_stopped(left_ids, series_map)
        right_stopped = _node_stopped(right_ids, series_map)
        if left_stopped and right_stopped:
            return "arret"
        if left_stopped:
            return "noeud_g"
        if right_stopped:
            return "noeud_d"
        if left_stopped is False or right_stopped is False:
            return "en_cours"
        return "inconnu"

    all_stopped = _node_stopped(all_manual_ids, series_map)
    if all_stopped is None:
        return "inconnu"
    return "arret" if all_stopped else "en_cours"


def _build_node_tables(left_sensors, right_sensors, series_map):
    def _table(node_sensors):
        if not node_sensors:
            return None
        latest = []
        for sensor in node_sensors:
            points = series_map.get(sensor["id"]) or []
            value = points[-1]["value"] if points else None
            latest.append({"name": sensor.get("name") or sensor.get("id"), "current": value})

        known_values = [item["current"] for item in latest if item["current"] is not None]
        avg = round(sum(known_values) / len(known_values), 2) if known_values else None

        for item in latest:
            item["current"] = round(item["current"], 2) if item["current"] is not None else None
            item["delta"] = round(item["current"] - avg, 2) if item["current"] is not None and avg is not None else None

        balanced = all(item["delta"] is not None and abs(item["delta"]) <= IMBALANCE_THRESHOLD_A for item in latest) if known_values else None

        return {"sensors": latest, "avg_current": avg, "balanced": balanced}

    return {"left": _table(left_sensors), "right": _table(right_sensors)}


def _detect_job(automate_points):
    if not automate_points:
        return None

    latest_value = automate_points[-1]["value"]
    job = next((j for j in JOBS if j["current_min"] <= latest_value <= j["current_max"]), None)
    if job is None:
        return None

    start_time = automate_points[-1]["time"]
    for point in reversed(automate_points):
        if job["current_min"] <= point["value"] <= job["current_max"]:
            start_time = point["time"]
        else:
            break

    elapsed_hours = round((automate_points[-1]["time"] - start_time).total_seconds() / 3600, 2)
    return {
        "name": job["name"],
        "elapsed_hours": elapsed_hours,
        "max_hours": job["max_duration_hours"],
        "overrun": elapsed_hours > job["max_duration_hours"],
    }


def _sum_series(sensor_ids, series_map):
    """Merge several chronological per-sensor series into a single total-current series.

    The automate's current is the tank's total current redistributed across its node
    sensors, so summing every sensor's latest known value at each timestamp reconstructs
    the tank-wide current even for tanks without an automate. A point is only emitted once
    every sensor has reported at least one value, to avoid understating the sum early on.
    """
    sensor_ids = [sid for sid in sensor_ids if series_map.get(sid)]
    if not sensor_ids:
        return []

    pointers = {sid: 0 for sid in sensor_ids}
    last_value = {sid: None for sid in sensor_ids}
    all_times = sorted({point["time"] for sid in sensor_ids for point in series_map[sid]})

    result = []
    for t in all_times:
        for sid in sensor_ids:
            points = series_map[sid]
            idx = pointers[sid]
            while idx < len(points) and points[idx]["time"] <= t:
                last_value[sid] = points[idx]["value"]
                idx += 1
            pointers[sid] = idx
        known = [v for v in last_value.values() if v is not None]
        if len(known) == len(sensor_ids):
            result.append({"time": t, "value": round(sum(known), 2)})
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

        node_mapped = [sensor for sensor in manual_sensors if get_node(tank, sensor)]
        if node_mapped:
            selected_sensors = sorted(
                node_mapped,
                key=lambda sensor: (get_node(tank, sensor), sensor.get("name") or ""),
            )[:4]
        else:
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

        for sensor_id in series_map:
            series_map[sensor_id] = sorted(series_map[sensor_id], key=lambda item: item["time"])

        for sensor in selected_sensors:
            if not series_map[sensor["id"]]:
                series_map[sensor["id"]] = _generate_random_series(sensor["id"], center=_sensor_base_value(sensor))

        if automation and not series_map[automation["id"]]:
            center = 4.0
            if selected_sensors and series_map[selected_sensors[0]["id"]]:
                center = series_map[selected_sensors[0]["id"]][-1]["value"]
            series_map[automation["id"]] = _generate_random_series(automation["id"], center=center)

        left_sensors = [s for s in selected_sensors if get_node(tank, s) == "left"]
        right_sensors = [s for s in selected_sensors if get_node(tank, s) == "right"]

        status = _tank_status(
            [s["id"] for s in left_sensors],
            [s["id"] for s in right_sensors],
            [s["id"] for s in selected_sensors],
            series_map,
        )
        nodes = _build_node_tables(left_sensors, right_sensors, series_map)
        total_current_series = _sum_series([s["id"] for s in selected_sensors], series_map)
        job = _detect_job(total_current_series)

        series = [
            {
                "label": sensor.get("name") or sensor.get("id") or "Capteur inconnu",
                "points": [
                    {
                        "time": item["time"].strftime("%H:%M:%S"),
                        "value": round(item["value"], 2),
                    }
                    for item in series_map[sensor["id"]]
                ],
            }
            for sensor in selected_sensors
        ]

        if automation:
            series.append(
                {
                    "label": automation.get("name") or "Automate",
                    "isAutomate": True,
                    "points": [
                        {
                            "time": item["time"].strftime("%H:%M:%S"),
                            "value": round(item["value"], 2),
                        }
                        for item in series_map[automation["id"]]
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
                "status": status,
                "nodes": nodes,
                "job": job,
            }
        )

    return view


def get_tank_views():
    """Public entry point used by other services (e.g. alerts) that need the same enriched
    per-tank view (status, node tables, job detection) without recomputing it themselves."""
    measurement_types = _get_measurement_type_map()
    sensors = load_sensors()
    measurements = load_measurements()
    return _build_tank_sensor_view(measurements, sensors, measurement_types)


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
