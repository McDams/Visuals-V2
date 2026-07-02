from flask import Blueprint, jsonify
from config.database import get_connection

kpis = Blueprint("kpis", __name__)

@kpis.route("/api/kpis")
def get_kpis():

    conn = get_connection()

    cursor = conn.cursor()

    query = """
    SELECT COUNT(*) AS total_mesures
    FROM measurements
    """

    cursor.execute(query)

    result = cursor.fetchone()

    conn.close()

    return jsonify(result)