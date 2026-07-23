from flask import Blueprint, abort, jsonify, request
from services.chart_service import get_dashboard_payload, get_tank_history


dashboard_bp = Blueprint("dashboard", __name__)


@dashboard_bp.route("/api/dashboard")
def dashboard_api():
    return jsonify(get_dashboard_payload())


@dashboard_bp.route("/api/tank/<tank>/history")
def tank_history_api(tank):
    hours = request.args.get("hours", default=1, type=float)
    if hours is None:
        abort(400, "hours must be a number")
    hours = max(0.25, min(hours, 48))

    history = get_tank_history(tank, hours)
    if history is None:
        abort(404, f"Aucun capteur trouvé pour la cuve {tank}")
    return jsonify(history)
