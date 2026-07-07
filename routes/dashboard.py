from flask import Blueprint, jsonify
from services.chart_service import get_dashboard_payload


dashboard_bp = Blueprint("dashboard", __name__)


@dashboard_bp.route("/api/dashboard")
def dashboard_api():
    return jsonify(get_dashboard_payload())
