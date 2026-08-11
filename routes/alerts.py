from flask import Blueprint, jsonify
from services.alert_service import get_alerts

# Groupe de routes pour les alertes.
alerts_bp = Blueprint("alerts", __name__)


@alerts_bp.route("/api/alerts")
def alerts_api():
    # Renvoie la liste des alertes actives, enveloppée dans un objet {"alerts": [...]}.
    return jsonify({"alerts": get_alerts()})
