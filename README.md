 # Visuals V2

Visuals V2 est un prototype léger en Flask pour visualiser la télémétrie des capteurs et des automates. Il prend en charge deux modes de données :

- Mode CSV (par défaut) — lit les fichiers situés dans le dossier `db/` pour des démonstrations locales rapides.
- Mode Postgres — lit les données depuis une base PostgreSQL en utilisant les mêmes tables/vues logiques (recommandé pour l'intégration et la production).

Contenu
- Aperçu
- Structure du projet
- Démarrage rapide (mode CSV)
- Intégration PostgreSQL (mode production)
- Modèle de données et format CSV
- Référence API
- Extension et déploiement
- Dépannage

Aperçu
--------
Cette application présente un tableau de bord opérateur qui :

- Affiche un graphique par cuve montrant jusqu'à 4 capteurs (et éventuellement une série d'automate)
- Calcule des KPI simples (courant/temperature moyens, comptages) et génère des alertes (surtension de courant, capteurs obsolètes)
- Utilise des valeurs synthétiques déterministes pour reconstituer les séries manquantes lors des démos

Structure du projet
------------------

- `app.py` — point d'entrée Flask et enregistrement des blueprints
- `routes/` — routes HTTP : `dashboard.py`, `kpis.py`, `alerts.py`
- `services/` — logique métier : `chart_service.py`, `kpi_service.py`, `alert_service.py`
- `db/` — fixtures CSV pour le mode démo : `sensors.csv`, `measurement_types.csv`, `measurements.csv`
- `templates/` — templates Jinja2 (UI)
- `static/` — JS/CSS client (Chart.js et code UI)

Démarrage rapide (mode CSV)
-------------------------

1. Créez et activez un environnement virtuel Python puis installez les dépendances :

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
py -3 -m pip install -r requirements.txt
```

2. Lancez le serveur de développement Flask :

```powershell
py -3 app.py
```

3. Ouvrez le tableau de bord dans votre navigateur :

http://127.0.0.1:5000

Par défaut, l'application lit les fichiers CSV dans `db/`. Modifiez ou remplacez ces fichiers pour changer les données de démonstration.

Intégration PostgreSQL (mode production / intégration)
----------------------------------------------------

Vous pouvez exécuter l'application contre une base PostgreSQL réelle. Le dépôt contient `config/database.py` que vous pouvez configurer pour retourner une connexion `psycopg2`. L'approche recommandée consiste à conserver la logique de parsing CSV et ajouter une couche d'accès aux données qui bascule entre CSV et Postgres selon une variable d'environnement.

1) Variables d'environnement

Définissez ces variables dans votre shell ou la configuration du service :

```powershell
setx PG_HOST "db-host"
setx PG_DATABASE "iotsensors"
setx PG_USER "readonly_user"
setx PG_PASSWORD "verysecret"
setx PG_PORT "5432"
setx USE_POSTGRES "true"
```

2) Exemple `config/database.py`

Le projet inclut `config/database.py`. Vérifiez ou adaptez selon votre environnement. Exemple :

```python
import os
import psycopg2

def get_connection():
		return psycopg2.connect(
				host=os.environ.get('PG_HOST','localhost'),
				database=os.environ.get('PG_DATABASE','iotsensors'),
				user=os.environ.get('PG_USER','user'),
				password=os.environ.get('PG_PASSWORD','pass'),
				port=os.environ.get('PG_PORT', '5432')
		)
```

3) Schéma d'accès aux données (changement minimal recommandé)

Dans `services/chart_service.py` (et de la même façon dans `kpi_service.py` / `alert_service.py`), ajoutez un petit basculeur pour choisir la source :

```python
import os
from config.database import get_connection

USE_POSTGRES = os.environ.get('USE_POSTGRES','').lower() in ('1','true','yes')

def _load_measurements():
		if USE_POSTGRES:
				return _fetch_measurements_from_db()
		return _load_csv('measurements.csv')

def _fetch_measurements_from_db():
		conn = get_connection()
		cur = conn.cursor()
		cur.execute('SELECT time, sensor_id, measurement_type_id, value_num FROM measurements ORDER BY time DESC LIMIT 10000')
		rows = [dict(time=r[0].isoformat(), sensor_id=str(r[1]), measurement_type_id=str(r[2]), value_num=str(r[3])) for r in cur.fetchall()]
		cur.close(); conn.close()
		return rows
```

4) Schéma PostgreSQL recommandé

Créez des tables (ou vues) qui correspondent aux colonnes CSV pour minimiser les changements côté Python.

Exemple DDL (Postgres) :

```sql
CREATE TABLE sensors (
	id uuid PRIMARY KEY,
	eui64 text,
	name text,
	tank text,
	enabled boolean,
	metadata jsonb,
	display_order int
);

CREATE TABLE measurement_types (
	id int PRIMARY KEY,
	code text,
	unit text,
	value_domain text,
	description text
);

CREATE TABLE measurements (
	time timestamptz,
	sensor_id uuid,
	measurement_type_id int,
	statistic_id int,
	value_num numeric,
	internal_count int
);

-- Vue de commodité pour requêtes simplifiées
CREATE VIEW vw_measurements AS
SELECT m.time, m.sensor_id::text AS sensor_id, mt.id AS measurement_type_id, m.value_num
FROM measurements m
JOIN measurement_types mt ON mt.id = m.measurement_type_id;
```

5) Exemple de requête KPI

Calculer le courant moyen (A) et la température par cuve (en supposant que le courant est stocké en mA) :

```sql
SELECT s.tank,
	AVG(CASE WHEN mt.code = 'current_measured' THEN m.value_num/1000.0 END) AS avg_current_A,
	AVG(CASE WHEN mt.code = 'temperature' THEN m.value_num END) AS avg_temp_C
FROM measurements m
JOIN measurement_types mt ON mt.id = m.measurement_type_id
JOIN sensors s ON s.id = m.sensor_id
GROUP BY s.tank;
```

Sécurité et permissions
-----------------------

- Créez un rôle en lecture seule pour l'application et accordez `SELECT` sur les tables `sensors`, `measurements` et `measurement_types` ou sur les vues exposées.
- Utilisez des variables d'environnement pour les identifiants — ne les chiffrez pas dans le dépôt.

Référence API
-------------

- `GET /` — page du tableau de bord (HTML)
- `GET /api/dashboard` — payload JSON consommé par le front-end (séries par cuve, méta)
- `GET /api/kpis` — résumé des KPI (JSON)
- `GET /api/alerts` — liste des alertes (JSON : niveau, message, cuve, capteur)

Modèle de données & format CSV
-----------------------------

Les fichiers CSV se trouvent dans `db/` et ont les formats suivants :

- `sensors.csv` — métadonnées capteurs (id,name,tank,enabled,display_order,...)
- `measurement_types.csv` — id,code,unit,description
- `measurements.csv` — time (ISO8601), sensor_id, measurement_type_id, value_num

Conservez les timestamps en ISO8601 (UTC) pour éviter les problèmes de parsing. Le fichier `services/chart_service.py` contient des helpers de parsing utilisés par l'application.

Extension du tableau de bord
---------------------------

- Pour ajouter un KPI : étendez `services/kpi_service.py` et, si nécessaire, exposez une route via `routes/kpis.py`.
- Pour ajouter des éléments UI : modifiez `templates/dashboard.html` et `static/js/dashboard.js`. Le front utilise Chart.js (logique de création des graphiques dans `static/js/dashboard.js`).
- Pour basculer complètement vers Postgres, implémentez les fonctions `_fetch_*_from_db()` et définissez `USE_POSTGRES=true`.

Dépannage
---------

- Graphiques vides : vérifiez que `db/measurements.csv` contient des lignes avec timestamps ISO, ou que vos requêtes SQL retournent des lignes.
- Erreur d'import `psycopg2` : installez avec `py -3 -m pip install psycopg2-binary`.
- Erreur de permissions DB : assurez-vous que l'utilisateur a les droits `SELECT` sur les tables/vues nécessaires.

FAQ / tâches courantes
---------------------

- Générer des données de démonstration : modifiez `db/measurements.csv` ou utilisez les helpers de génération synthétique dans `services/chart_service.py`.
- Exécuter en production : utilisez un serveur WSGI (Gunicorn/Uvicorn) et un reverse-proxy. Fournissez les variables d'environnement DB et définissez `USE_POSTGRES=true`.

Prochaines étapes que je peux réaliser pour vous
-----------------------------------------------

- Connecter le front-end pour afficher les cartes KPI et le panneau d'alertes (modifications HTML+JS).
- Ajouter la bascule automatique `USE_POSTGRES` dans tous les services et fournir un script SQL pour remplir les tables à partir des CSV.

Dites-moi laquelle de ces tâches vous voulez que je réalise ensuite et j'attaque la modification.


