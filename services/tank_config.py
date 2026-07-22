# Physical left/right node mapping per tank. Keys are matched against a sensor's "name"
# first, then its "eui64" (used for KS2, whose manual sensors have no name in the database).
NODE_MAP = {
    "KS1": {"13": "left", "14": "left", "11": "right", "12": "right"},
    "KS2": {
        # KS2's manual sensors have no name, only an eui64. There is no physical left/right
        # information available for them, so they are split by display_order (the two lowest
        # = left, the two highest = right) as a deterministic placeholder — correct the
        # mapping below once the real layout is known.
        "F4CE3615B2076C01": "left",   # display_order 6
        "F4CE36735C9A8290": "left",   # display_order 9
        "F4CE36AC7ADAD99C": "right",  # display_order 10
        "F4CE3672AAE9A258": "right",  # display_order 11
    },
    "KS3": {"15": "left", "16": "left", "17": "right", "18": "right"},
    "KS4": {"3": "left", "7": "left", "1": "right", "2": "right"},
}

# Measurement type codes that carry a current value. Per measurement_types' descriptions,
# "current_measured" is automaton-specific while individual node sensors report under the
# generic "current" code ("sensor supplied") — both must be accepted or per-sensor readings
# are silently dropped.
CURRENT_CODES = {"current", "current_measured"}

# Voltage only has an automaton-reported code in the current schema: "voltage" ("Voltage from
# automaton if available") and "voltage_measured" ("Voltage measured automaton") are both
# automaton-only, and are NOT interchangeable like the current codes — "voltage" can carry a
# different, occasionally negative, raw/setpoint-like value. Only "voltage_measured" is a true
# measurement, so it is the only one used everywhere a "voltage" is displayed.
VOLTAGE_CODES = {"voltage_measured"}

# Measurement type code for the automaton's target current (used to derive an expected
# per-sensor setpoint = total setpoint / number of sensors currently reporting data).
CURRENT_SETPOINT_CODE = "current_setpoint"

# A tank/node is considered stopped once its current has stayed below this threshold for
# longer than STOP_DURATION_SECONDS.
STOP_CURRENT_THRESHOLD_A = 10.0
STOP_DURATION_SECONDS = 60

# A sensor is flagged with a "Pas de données récentes" alert once its last reading is older
# than this. Tune it to your real sensors' reporting interval plus some margin for network/
# polling jitter — too tight and healthy sensors will false-positive on every normal delay.
SENSOR_STALE_SECONDS = 60

# Alert threshold for current imbalance between sensors of the same tank.
IMBALANCE_THRESHOLD_A = 5.0

# Fixed current axis (Amps) shared by every tank chart so severity reads the same across
# cuves. The automate line uses its own secondary axis since it reports a much larger,
# tank-wide current than the individual node sensors.
CHART_CURRENT_AXIS_MAX = 220

# Job current bands used to auto-detect which job is running (based on the tank's total
# current — the sum of its node sensors' currents, which equals the automate's current
# since that current is redistributed across the sensors) and how long it is allowed to
# run before a production-time alert fires.
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


def get_node(tank, sensor):
    """sensor is the sensor dict; matched by name first, then eui64 (for nameless sensors)."""
    node_map = NODE_MAP.get(tank, {})
    name = (sensor.get("name") or "").strip()
    eui64 = (sensor.get("eui64") or "").strip()
    return node_map.get(name) or node_map.get(eui64)
