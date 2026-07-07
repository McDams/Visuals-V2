# Visuals V2

Prototype Flask dashboard that reads CSV files from `db/` and renders Chart.js visualizations.

Features
- Per-tank charts (one chart per tank with up to 4 sensors + optional automate series)
- Synthetic data generation for missing sensor series
- KPI and Alerts computed from CSV snapshots
- Simple filter panel (tank/automation)

Run locally

1. Create a Python 3.10+ virtualenv and install requirements:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
py -3 -m pip install -r requirements.txt
```

2. Start the app:

```powershell
py -3 app.py
```

APIs
- `/api/dashboard` – dashboard payload consumed by `static/js/dashboard.js`
- `/api/kpis` – KPI summary (CSV-driven)
- `/api/alerts` – current alerts derived from CSV snapshot

Notes
- CSV files are in `db/` and are the source of truth for the demo.
- `services/chart_service.py` synthesizes missing sensor series to make the demo look populated.
