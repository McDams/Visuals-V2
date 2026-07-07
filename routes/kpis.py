from flask import Blueprint, jsonify
from services.kpi_service import get_kpis

kpis_bp = Blueprint("kpis", __name__)


@kpis_bp.route("/api/kpis")
def get_kpis_api():
    return jsonify(get_kpis())