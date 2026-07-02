from flask import Flask
from routes.kpis import kpis_bp

app = Flask(__name__)
app.register_blueprint(kpis_bp)

@app.route("/")
def home():
    return "Dashboard Electroformage"


if __name__ == "__main__":
    app.run(debug=True)