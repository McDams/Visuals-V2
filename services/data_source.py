import csv
import os
from pathlib import Path

from config.database import get_connection

# Dossier racine du projet et dossier des fixtures CSV (utilisées en mode démo).
BASE_DIR = Path(__file__).resolve().parent.parent
DB_DIR = BASE_DIR / "db"

# Bascule CSV / PostgreSQL et fenêtre temps réel, lues une fois au chargement du module
# depuis les variables d'environnement (voir README).
USE_POSTGRES = os.environ.get("USE_POSTGRES", "").strip().lower() in ("1", "true", "yes")
REALTIME_WINDOW_MINUTES = int(os.environ.get("REALTIME_WINDOW_MINUTES", "60"))


def _load_csv(filename):
    """Lit un fichier CSV du dossier db/ en liste de dicts, en convertissant les "NULL"
    textuels en None (comme le ferait la base)."""
    with (DB_DIR / filename).open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        for key, value in row.items():
            if isinstance(value, str) and value.strip().upper() == "NULL":
                row[key] = None
    return rows


def _query(sql, params=None):
    """Exécute une requête SQL et renvoie les lignes en liste de dicts. Ouvre et referme une
    connexion à chaque appel (pas de pool) — suffisant ici et évite tout état partagé."""
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(sql, params or ())
        columns = [desc[0] for desc in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        cur.close()
        return rows
    finally:
        conn.close()


def parse_float(value):
    """Convertit en float de façon tolérante ; renvoie None si vide ou non convertible."""
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_time(value):
    """Parse un timestamp ISO en datetime, en le ramenant en heure locale naïve.

    Les timestamps Postgres/CSV portent un décalage (souvent UTC). On les convertit en heure
    locale sans fuseau pour qu'ils s'alignent avec datetime.now() (utilisé pour la série de
    secours synthétique et les contrôles de fraîcheur) — sinon on mélangeait des heures UTC et
    locales, ce qui faisait apparaître l'axe des graphes décalé de plusieurs heures par rapport
    au reste de l'interface.
    """
    if not value:
        return None
    from datetime import datetime

    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None

    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def parse_bool(value):
    """Convertit en booléen (accepte les booléens natifs et les chaînes "true"/"false")."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() == "true"
    return False


def load_sensors():
    """Renvoie les métadonnées des capteurs (liste de dicts, valeurs en chaînes comme le CSV).

    En mode PostgreSQL, on force id et display_order en chaînes pour que le reste du code
    (comparaisons de clés, .isdigit(), etc.) fonctionne à l'identique du mode CSV.
    """
    if not USE_POSTGRES:
        return _load_csv("sensors.csv")

    rows = _query(
        "SELECT id, eui64, name, tank, enabled, metadata, display_order FROM sensors"
    )
    for row in rows:
        row["id"] = str(row["id"]) if row.get("id") is not None else None
        row["display_order"] = (
            str(row["display_order"]) if row.get("display_order") is not None else None
        )
    return rows


def load_measurement_types():
    """Renvoie les types de mesure (liste de dicts), id forcé en chaîne comme en mode CSV."""
    if not USE_POSTGRES:
        return _load_csv("measurement_types.csv")

    rows = _query(
        "SELECT id, code, unit, value_domain, description FROM measurement_types"
    )
    for row in rows:
        row["id"] = str(row["id"]) if row.get("id") is not None else None
    return rows


def load_measurements(window_minutes=None, sensor_ids=None):
    """Renvoie les mesures récentes (liste de dicts, même forme que le CSV).

    En mode Postgres, on ne récupère que les `window_minutes` dernières minutes
    (REALTIME_WINDOW_MINUTES par défaut) pour que le dashboard live reflète des données
    récentes plutôt que toute la table. Passer un `window_minutes` explicite permet une
    requête ponctuelle sur une plage plus large (ex : historique de plusieurs heures) sans
    changer la fenêtre de polling par défaut.

    Passer `sensor_ids` restreint la requête à quelques capteurs (ceux d'une cuve). C'est
    important sur les fenêtres larges : la requête est plafonnée à 50000 lignes, et sans filtre
    ce plafond est partagé entre tous les capteurs de toutes les cuves — un système chargé peut
    l'épuiser en quelques minutes même quand on a demandé 24 h, tronquant silencieusement le
    résultat à une plage bien plus courte que demandé.
    """
    if not USE_POSTGRES:
        # Mode CSV : on charge tout le fichier puis on filtre éventuellement par capteur.
        rows = _load_csv("measurements.csv")
        if sensor_ids is not None:
            ids = set(sensor_ids)
            rows = [row for row in rows if row.get("sensor_id") in ids]
        return rows

    minutes = REALTIME_WINDOW_MINUTES if window_minutes is None else window_minutes
    if sensor_ids:
        # Requête filtrée sur les capteurs demandés (=ANY sur un tableau d'uuid).
        rows = _query(
            """
            SELECT time, sensor_id, measurement_type_id, statistic_id, value_num, internal_count
            FROM measurements
            WHERE time > now() - (%s * interval '1 minute')
              AND sensor_id = ANY(%s::uuid[])
            ORDER BY time DESC
            LIMIT 50000
            """,
            (minutes, list(sensor_ids)),
        )
    else:
        # Requête globale (tous capteurs) pour le dashboard live.
        rows = _query(
            """
            SELECT time, sensor_id, measurement_type_id, statistic_id, value_num, internal_count
            FROM measurements
            WHERE time > now() - (%s * interval '1 minute')
            ORDER BY time DESC
            LIMIT 50000
            """,
            (minutes,),
        )
    # Normalisation des types pour coller à la forme du CSV (chaînes / ISO) attendue en aval.
    for row in rows:
        row["time"] = row["time"].isoformat() if row.get("time") is not None else None
        row["sensor_id"] = str(row["sensor_id"]) if row.get("sensor_id") is not None else None
        row["measurement_type_id"] = (
            str(row["measurement_type_id"]) if row.get("measurement_type_id") is not None else None
        )
    return rows
