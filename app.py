import os

from dotenv import load_dotenv

load_dotenv()

from flask import Flask, render_template
from routes.kpis import kpis_bp
from routes.dashboard import dashboard_bp
from routes.alerts import alerts_bp

app = Flask(__name__)
app.register_blueprint(kpis_bp)
app.register_blueprint(dashboard_bp)
app.register_blueprint(alerts_bp)

@app.route("/")
def home():
    return render_template("dashboard.html")


if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))