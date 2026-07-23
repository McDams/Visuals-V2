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
    CURRENT_CODES,
    CURRENT_SETPOINT_CODE,
    IMBALANCE_THRESHOLD_A,
    JOBS,
    STOP_CURRENT_THRESHOLD_A,
    STOP_DURATION_SECONDS,
    VOLTAGE_CODES,
    get_node,
)


def _sensor_base_value(sensor):
    name = (sensor.get("name") or "").strip().lower()
    if name.startswith("auto"):
        return 4.0
    if name.isdigit():
        return 3.8 + (int(name) % 4) * 0.12
    return 3.9


def _generate_random_series(sensor_id, center=4.0, count=6, deviation=0.18, reference_time=None):
    """Synthetic fallback series for a sensor with no real row in the current window.

    Anchored to `reference_time` (the tank's latest real timestamp, if any) rather than
    datetime.now(), so a silent sensor's placeholder points end at the same instant as the
    tank's real data instead of floating disconnected in a completely different time range.
    """
    rnd = random.Random(sensor_id)
    anchor = reference_time or datetime.now()
    return [
        {
            "time": anchor - timedelta(seconds=(count - 1 - index) * 2),
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


def _build_series(rows, sensors, measurement_types, codes, group_mode):
    grouped = defaultdict(list)
    sensor_lookup = {sensor.get("id"): sensor for sensor in sensors if sensor.get("id")}

    for row in rows:
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        code = measurement_type.get("code")
        if code not in codes:
            continue

        parsed_time = _parse_time(row.get("time"))
        value = _parse_float(row.get("value_num"))
        if parsed_time is None or value is None:
            continue
        if code in CURRENT_CODES or code in VOLTAGE_CODES:
            # measurements are in milli-units in CSV; convert to A / V
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


def _build_node_tables(left_sensors, right_sensors, series_map, sensors_with_real_data):
    def _table(node_sensors):
        if not node_sensors:
            return None
        latest = []
        for sensor in node_sensors:
            has_data = sensor["id"] in sensors_with_real_data
            points = series_map.get(sensor["id"]) or []
            value = points[-1]["value"] if points else None
            # Only report a last-seen timestamp for sensors with a real row: the synthetic
            # fallback series is timestamped "now" and would otherwise look falsely fresh.
            last_seen = points[-1]["time"] if has_data and points else None
            latest.append(
                {
                    "name": sensor.get("name") or sensor.get("id"),
                    "current": value,
                    "reporting": has_data,
                    "last_seen": last_seen.isoformat() if last_seen else None,
                }
            )

        known_values = [item["current"] for item in latest if item["current"] is not None]
        avg = round(sum(known_values) / len(known_values), 2) if known_values else None

        for item in latest:
            item["current"] = round(item["current"], 2) if item["current"] is not None else None
            item["delta"] = round(item["current"] - avg, 2) if item["current"] is not None and avg is not None else None

        balanced = all(item["delta"] is not None and abs(item["delta"]) <= IMBALANCE_THRESHOLD_A for item in latest) if known_values else None
        reporting_count = sum(1 for item in latest if item["reporting"])

        return {
            "sensors": latest,
            "avg_current": avg,
            "balanced": balanced,
            "reporting_count": reporting_count,
            "sensor_count": len(latest),
        }

    return {"left": _table(left_sensors), "right": _table(right_sensors)}


def _matching_job(value):
    return next((j for j in JOBS if j["current_min"] <= value <= j["current_max"]), None)


def _detect_job(current_points):
    """Identify the job running on a tank from its total current, and report timing:

    - If the latest current matches a job band, walk backward to find when it started
      running that job, and derive the predicted end time from the job's max duration.
    - Otherwise, walk backward to find since when the current has matched no job band at
      all, i.e. since when the tank stopped running a recognizable job.
    """
    if not current_points:
        return None

    latest_point = current_points[-1]
    job = _matching_job(latest_point["value"])

    if job:
        start_time = latest_point["time"]
        for point in reversed(current_points):
            if job["current_min"] <= point["value"] <= job["current_max"]:
                start_time = point["time"]
            else:
                break

        elapsed_hours = round((latest_point["time"] - start_time).total_seconds() / 3600, 2)
        predicted_end = start_time + timedelta(hours=job["max_duration_hours"])
        return {
            "name": job["name"],
            "elapsed_hours": elapsed_hours,
            "max_hours": job["max_duration_hours"],
            "overrun": elapsed_hours > job["max_duration_hours"],
            "start_time": start_time.isoformat(),
            "predicted_end": predicted_end.isoformat(),
        }

    not_running_since = latest_point["time"]
    for point in reversed(current_points):
        if _matching_job(point["value"]) is None:
            not_running_since = point["time"]
        else:
            break

    return {"name": None, "not_running_since": not_running_since.isoformat()}


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


def _latest_setpoint(rows, measurement_types, sensor_ids):
    """Latest current_setpoint value (A) reported by any of the given sensors."""
    latest_time = None
    latest_value = None
    for row in rows:
        if row.get("sensor_id") not in sensor_ids:
            continue
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        if measurement_type.get("code") != CURRENT_SETPOINT_CODE:
            continue
        parsed_time = _parse_time(row.get("time"))
        value = _parse_float(row.get("value_num"))
        if parsed_time is None or value is None:
            continue
        if latest_time is None or parsed_time > latest_time:
            latest_time = parsed_time
            latest_value = value / 1000.0
    return latest_value


def _current_counts(rows, measurement_types):
    """How many current rows each sensor reported, used to prioritize sensors with data
    when a tank has no NODE_MAP entry to fall back on."""
    counts = defaultdict(int)
    for row in rows:
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        if measurement_type.get("code") not in CURRENT_CODES:
            continue
        sensor_id = row.get("sensor_id")
        if sensor_id:
            counts[sensor_id] += 1
    return counts


def _resolve_tank_sensors(tank, sensors, current_counts):
    """Pick the automate (if any) and up to 4 manual sensors representing this tank,
    preferring the physical left/right NODE_MAP order over raw data coverage."""
    tank_sensors = [sensor for sensor in sensors if (sensor.get("tank") or "") == tank and sensor.get("id")]
    if not tank_sensors:
        return None, []

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

    return automation, selected_sensors


def _build_tank_sensor_view(rows, sensors, measurement_types):
    current_counts = _current_counts(rows, measurement_types)
    tanks = sorted({sensor.get("tank") for sensor in sensors if sensor.get("tank")})
    view = []

    for tank in tanks:
        tank_sensors = [sensor for sensor in sensors if (sensor.get("tank") or "") == tank and sensor.get("id")]
        if not tank_sensors:
            continue

        setpoint_total = _latest_setpoint(rows, measurement_types, {s["id"] for s in tank_sensors})
        automation, selected_sensors = _resolve_tank_sensors(tank, sensors, current_counts)

        series_map = {sensor["id"]: [] for sensor in selected_sensors}
        if automation:
            series_map[automation["id"]] = []

        for row in rows:
            sensor_id = row.get("sensor_id")
            if sensor_id not in series_map:
                continue

            measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
            if measurement_type.get("code") not in CURRENT_CODES:
                continue

            parsed_time = _parse_time(row.get("time"))
            value = _parse_float(row.get("value_num"))
            if parsed_time is None or value is None:
                continue
            value = value / 1000.0

            series_map[sensor_id].append({"time": parsed_time, "value": value})

        for sensor_id in series_map:
            series_map[sensor_id] = sorted(series_map[sensor_id], key=lambda item: item["time"])

        # Snapshot which sensors actually reported a real row before filling in the
        # synthetic fallback below, so the UI can tell "sending data" apart from "faked
        # for the demo" instead of a fake recent timestamp masking a silent sensor.
        sensors_with_real_data = {sensor_id for sensor_id, points in series_map.items() if points}

        # Anchor synthetic fallback points to the tank's latest real timestamp (if any)
        # instead of datetime.now(), so a silent sensor's placeholder curve ends at the same
        # instant as the automate/other sensors' real data rather than in an unrelated time
        # range (this made the automate line look "not simultaneous" with sensor lines).
        reference_time = None
        for points in series_map.values():
            if points and (reference_time is None or points[-1]["time"] > reference_time):
                reference_time = points[-1]["time"]

        for sensor in selected_sensors:
            if not series_map[sensor["id"]]:
                series_map[sensor["id"]] = _generate_random_series(
                    sensor["id"], center=_sensor_base_value(sensor), reference_time=reference_time
                )

        if automation and not series_map[automation["id"]]:
            center = 4.0
            if selected_sensors and series_map[selected_sensors[0]["id"]]:
                center = series_map[selected_sensors[0]["id"]][-1]["value"]
            series_map[automation["id"]] = _generate_random_series(
                automation["id"], center=center, reference_time=reference_time
            )

        left_sensors = [s for s in selected_sensors if get_node(tank, s) == "left"]
        right_sensors = [s for s in selected_sensors if get_node(tank, s) == "right"]

        status = _tank_status(
            [s["id"] for s in left_sensors],
            [s["id"] for s in right_sensors],
            [s["id"] for s in selected_sensors],
            series_map,
        )
        nodes = _build_node_tables(left_sensors, right_sensors, series_map, sensors_with_real_data)
        sensors_reporting = sum(1 for s in selected_sensors if s["id"] in sensors_with_real_data)
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
                "sensors_reporting": sensors_reporting,
                "sensors_total": len(selected_sensors),
                "setpoint": {
                    "total": round(setpoint_total, 2) if setpoint_total is not None else None,
                    # Expected setpoint per currently-reporting sensor, rather than the raw
                    # automate-wide total, so it can be compared directly to individual
                    # sensor readings on the chart.
                    "per_sensor": round(setpoint_total / sensors_reporting, 2)
                    if setpoint_total is not None and sensors_reporting > 0
                    else None,
                },
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


def get_tank_history(tank, hours):
    """Chart series for one tank over a wider, caller-chosen window (e.g. 6h/24h), decoupled
    from the live dashboard's short REALTIME_WINDOW_MINUTES so browsing history doesn't slow
    down the main polling loop. Points carry full ISO timestamps (not HH:MM:SS) since a
    multi-hour range can span midnight. No synthetic fallback: a silent sensor just shows a
    gap, real history shouldn't be padded with fake data.
    """
    measurement_types = _get_measurement_type_map()
    sensors = load_sensors()
    measurements = load_measurements(window_minutes=int(hours * 60))

    current_counts = _current_counts(measurements, measurement_types)
    automation, selected_sensors = _resolve_tank_sensors(tank, sensors, current_counts)
    if not selected_sensors and not automation:
        return None

    sensor_ids = {s["id"] for s in selected_sensors}
    if automation:
        sensor_ids.add(automation["id"])

    series_map = defaultdict(list)
    for row in measurements:
        sensor_id = row.get("sensor_id")
        if sensor_id not in sensor_ids:
            continue
        measurement_type = measurement_types.get(row.get("measurement_type_id"), {})
        if measurement_type.get("code") not in CURRENT_CODES:
            continue
        parsed_time = _parse_time(row.get("time"))
        value = _parse_float(row.get("value_num"))
        if parsed_time is None or value is None:
            continue
        series_map[sensor_id].append({"time": parsed_time, "value": round(value / 1000.0, 2)})

    for sensor_id in series_map:
        series_map[sensor_id] = sorted(series_map[sensor_id], key=lambda item: item["time"])

    def _points(sensor_id):
        return [{"time": item["time"].isoformat(), "value": item["value"]} for item in series_map.get(sensor_id, [])]

    series = [
        {"label": sensor.get("name") or sensor.get("id") or "Capteur inconnu", "points": _points(sensor["id"])}
        for sensor in selected_sensors
    ]
    if automation:
        series.append(
            {
                "label": automation.get("name") or "Automate",
                "isAutomate": True,
                "points": _points(automation["id"]),
            }
        )

    return {
        "tank": tank,
        "hours": hours,
        "automation": automation.get("name") if automation else None,
        "series": series,
    }


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

        if code in CURRENT_CODES or code in VOLTAGE_CODES:
            value = _parse_float(row.get("value_num"))
            if value is not None:
                # measurements are in milli-units in CSV; convert to A / V
                value = value / 1000.0
                key = "current_measured" if code in CURRENT_CODES else "voltage_measured"
                tank_stats[tank][key].append(value)

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
                            if measurement_types.get(row.get("measurement_type_id"), {}).get("code") in CURRENT_CODES
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
                "current": _build_series(measurements, sensors, measurement_types, CURRENT_CODES, "tank"),
                "voltage": _build_series(measurements, sensors, measurement_types, VOLTAGE_CODES, "tank"),
            },
            "by_automation": {
                "current": _build_series(measurements, sensors, measurement_types, CURRENT_CODES, "automation"),
            },
            "by_sensor": {
                "current": _build_series(measurements, sensors, measurement_types, CURRENT_CODES, "sensor"),
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
