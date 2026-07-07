from flask import Blueprint, jsonify
from services.alert_service import get_alerts

alerts_bp = Blueprint("alerts", __name__)


@alerts_bp.route("/api/alerts")
def alerts_api():
	return jsonify({"alerts": get_alerts()})
