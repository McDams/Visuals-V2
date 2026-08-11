from flask import Blueprint, abort, jsonify, request
from services.chart_service import get_dashboard_payload, get_tank_history


# Groupe de routes du tableau de bord (données live + historique par cuve).
dashboard_bp = Blueprint("dashboard", __name__)


@dashboard_bp.route("/api/dashboard")
def dashboard_api():
    # Renvoie le payload complet consommé par le front (séries par cuve, résumé, process).
    return jsonify(get_dashboard_payload())


@dashboard_bp.route("/api/tank/<tank>/history")
def tank_history_api(tank):
    # Historique du courant d'une cuve sur une fenêtre choisie (boutons 6h/24h du modal).
    # `hours` est borné entre 0,25 h et 48 h pour éviter des requêtes absurdes.
    hours = request.args.get("hours", default=1, type=float)
    if hours is None:
        abort(400, "hours must be a number")
    hours = max(0.25, min(hours, 48))

    history = get_tank_history(tank, hours)
    # get_tank_history renvoie None si la cuve n'a aucun capteur connu -> 404.
    if history is None:
        abort(404, f"Aucun capteur trouvé pour la cuve {tank}")
    return jsonify(history)
