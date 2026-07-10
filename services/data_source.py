import csv
import os
from pathlib import Path

from config.database import get_connection

BASE_DIR = Path(__file__).resolve().parent.parent
DB_DIR = BASE_DIR / "db"

USE_POSTGRES = os.environ.get("USE_POSTGRES", "").strip().lower() in ("1", "true", "yes")
REALTIME_WINDOW_MINUTES = int(os.environ.get("REALTIME_WINDOW_MINUTES", "60"))


def _load_csv(filename):
    with (DB_DIR / filename).open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        for key, value in row.items():
            if isinstance(value, str) and value.strip().upper() == "NULL":
                row[key] = None
    return rows


def _query(sql, params=None):
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(sql, params or ())
        columns = [desc[0] for desc in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        cur.close()
        return rows
    finally:
        conn.close()


def parse_float(value):
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_time(value):
    if not value:
        return None
    from datetime import datetime

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None

    if parsed.tzinfo is not None:
        # Postgres/CSV timestamps carry a UTC-ish offset; convert to naive local time so
        # they line up with datetime.now() (used for the synthetic fallback series and
        # staleness checks) instead of silently mixing UTC and local hours, which made
        # chart x-axis labels look hours apart from the rest of the UI.
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def parse_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() == "true"
    return False


def load_sensors():
    """Return sensor metadata as a list of dicts with string values (matches CSV shape)."""
    if not USE_POSTGRES:
        return _load_csv("sensors.csv")

    rows = _query(
        "SELECT id, eui64, name, tank, enabled, metadata, display_order FROM sensors"
    )
    for row in rows:
        row["id"] = str(row["id"]) if row.get("id") is not None else None
        row["display_order"] = (
            str(row["display_order"]) if row.get("display_order") is not None else None
        )
    return rows


def load_measurement_types():
    """Return measurement type metadata as a list of dicts (matches CSV shape)."""
    if not USE_POSTGRES:
        return _load_csv("measurement_types.csv")

    rows = _query(
        "SELECT id, code, unit, value_domain, description FROM measurement_types"
    )
    for row in rows:
        row["id"] = str(row["id"]) if row.get("id") is not None else None
    return rows


def load_measurements():
    """Return recent measurements as a list of dicts (matches CSV shape).

    In Postgres mode, only the last REALTIME_WINDOW_MINUTES minutes are fetched so the
    dashboard reflects live production data instead of the entire measurements table.
    """
    if not USE_POSTGRES:
        return _load_csv("measurements.csv")

    rows = _query(
        """
        SELECT time, sensor_id, measurement_type_id, statistic_id, value_num, internal_count
        FROM measurements
        WHERE time > now() - (%s * interval '1 minute')
        ORDER BY time DESC
        """,
        (REALTIME_WINDOW_MINUTES,),
    )
    for row in rows:
        row["time"] = row["time"].isoformat() if row.get("time") is not None else None
        row["sensor_id"] = str(row["sensor_id"]) if row.get("sensor_id") is not None else None
        row["measurement_type_id"] = (
            str(row["measurement_type_id"]) if row.get("measurement_type_id") is not None else None
        )
    return rows
