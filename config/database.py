import os


def get_connection():
    import psycopg2

    return psycopg2.connect(
        host=os.environ.get("PG_HOST", "localhost"),
        database=os.environ.get("PG_DATABASE", "iotsensors"),
        user=os.environ.get("PG_USER", "user"),
        password=os.environ.get("PG_PASSWORD", ""),
        port=os.environ.get("PG_PORT", "5432"),
    )
