from flask import Blueprint, jsonify
from config.database import get_connection

kpis_bp = Blueprint("kpis", __name__)


@kpis_bp.route("/api/kpis")
def get_kpis():
    conn = get_connection()
    cursor = conn.cursor()
    query = """
    SELECT
        ROUND(AVG(
            CASE
                WHEN code = 'temperature'
                THEN value_num
            END
        )::numeric,2) AS temperature_moyenne,

        ROUND(AVG(
            CASE
                WHEN code = 'current'
                THEN value_num
            END
        )::numeric,2) AS courant_moyen,
        COUNT(DISTINCT tank) AS nombre_cuves,
        COUNT(DISTINCT sensor_id) AS nombre_capteurs
    FROM vw_process_data

    """
    cursor.execute(query)
    result = cursor.fetchone()
    conn.close()
    return jsonify({
        "temperature_moyenne": result[0],
        "courant_moyen": result[1],
        "nombre_cuves": result[2],
        "nombre_capteurs": result[3]
    })