# =====================================================================================
# Supervision Électroformage — application Flask (dashboard temps réel des cuves).
# Plateforme conçue et développée par Donou Awadji Mahouna Serge.
# =====================================================================================
import os

# Charge les variables d'environnement depuis un fichier .env s'il existe (identifiants
# PostgreSQL, USE_POSTGRES, etc.). Doit être appelé AVANT d'importer les modules qui lisent
# ces variables au chargement (par ex. services.data_source lit USE_POSTGRES à l'import).
from dotenv import load_dotenv

load_dotenv()

from flask import Flask, render_template

# Chaque "blueprint" regroupe les routes d'un domaine (KPI, dashboard, alertes).
from routes.kpis import kpis_bp
from routes.dashboard import dashboard_bp
from routes.alerts import alerts_bp

# Création de l'application Flask et enregistrement des groupes de routes.
app = Flask(__name__)
app.register_blueprint(kpis_bp)
app.register_blueprint(dashboard_bp)
app.register_blueprint(alerts_bp)


@app.route("/")
def home():
    # Page unique du tableau de bord (le reste des données arrive via les routes /api/*).
    return render_template("dashboard.html")


if __name__ == "__main__":
    # Serveur de développement uniquement. En production, utiliser un serveur WSGI
    # (waitress / gunicorn) — voir le README. Le port est configurable via la variable PORT.
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))
