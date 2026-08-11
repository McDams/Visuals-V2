from flask import Blueprint, jsonify
from services.kpi_service import get_kpis

# Groupe de routes pour les indicateurs (KPI).
kpis_bp = Blueprint("kpis", __name__)


@kpis_bp.route("/api/kpis")
def get_kpis_api():
    # Renvoie en JSON les KPI calculés par le service (moyennes, détail par cuve).
    return jsonify(get_kpis())
