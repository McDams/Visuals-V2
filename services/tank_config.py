# Physical left/right node mapping per tank, keyed by sensor "name" (as stored in
# sensors.csv / the sensors table). Fill in KS1 and KS2 once the physical layout is known;
# until then those tanks fall back to an unsplit view (no node table, simple running/stopped
# status only).
NODE_MAP = {
    "KS3": {"15": "left", "16": "left", "17": "right", "18": "right"},
    "KS4": {"3": "left", "7": "left", "1": "right", "2": "right"},
}

# A tank/node is considered stopped once its current has stayed below this threshold for
# longer than STOP_DURATION_SECONDS.
STOP_CURRENT_THRESHOLD_A = 10.0
STOP_DURATION_SECONDS = 60

# Alert threshold for current imbalance between sensors of the same tank.
IMBALANCE_THRESHOLD_A = 5.0

# Fixed current axis (Amps) shared by every tank chart so severity reads the same across
# cuves. The automate line uses its own secondary axis since it reports a much larger,
# tank-wide current than the individual node sensors.
CHART_CURRENT_AXIS_MAX = 220

# Job current bands used to auto-detect which job is running (based on the automate's
# current) and how long it is allowed to run before a production-time alert fires.
JOBS = [
    {"name": "Porteur", "current_min": 75.0, "current_max": 105.0, "max_duration_hours": 16},
    {"name": "Cliché", "current_min": 160.0, "current_max": 200.0, "max_duration_hours": 2},
]

# pH monitoring is not wired yet: neither the demo CSV nor the documented schema has a ph
# measurement code. Set these once the real code + acceptable range are known (see README)
# to activate the "Alerte pH" check.
PH_MEASUREMENT_CODE = None
PH_MIN = None
PH_MAX = None


def get_node(tank, sensor_name):
    return NODE_MAP.get(tank, {}).get(sensor_name)
