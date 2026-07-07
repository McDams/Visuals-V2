from flask import Flask, render_template
from routes.kpis import kpis_bp
from routes.dashboard import dashboard_bp

app = Flask(__name__)
app.register_blueprint(kpis_bp)
app.register_blueprint(dashboard_bp)

@app.route("/")
def home():
    return render_template("dashboard.html")


if __name__ == "__main__":
    app.run(debug=True)