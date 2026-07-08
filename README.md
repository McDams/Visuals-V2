# Visuals V2

Visuals V2 est un tableau de bord Flask pour la supervision temps réel de cuves d'électroformage (courant, tension, alertes, état de production). Il est pensé pour être affiché sur un écran d'atelier : gros indicateurs, alarmes visibles, actualisation automatique toutes les 5 secondes.

Il prend en charge deux sources de données, contrôlées par la variable d'environnement `USE_POSTGRES` :

- **Mode CSV** (par défaut) — lit les fichiers du dossier `db/` pour des démos locales, sans base de données.
- **Mode PostgreSQL** (production) — lit les données en direct depuis la base PostgreSQL existante. **C'est ce mode qu'il faut activer pour avoir des valeurs en temps réel.**

Contenu
- [Aperçu](#aperçu)
- [Structure du projet](#structure-du-projet)
- [Démarrage rapide (mode CSV)](#démarrage-rapide-mode-csv)
- [Connecter la base PostgreSQL (temps réel)](#connecter-la-base-postgresql-temps-réel)
- [Référence API](#référence-api)
- [Modèle de données et format CSV](#modèle-de-données--format-csv)
- [Sécurité](#sécurité)
- [Dépannage](#dépannage)

Aperçu
--------
Cette application présente un tableau de bord opérateur qui :

- Affiche une carte par cuve avec son graphique de courant (jusqu'à 4 capteurs + automate)
- Calcule des KPI (courant/température moyens, nombre de cuves/capteurs actifs)
- Suit l'état du process en cours (recette, segment, temps restant)
- Génère des alertes (surtension de courant, capteurs sans données récentes) et les affiche en bandeau défilant + panneau détaillé
- En mode CSV, reconstitue des séries synthétiques déterministes pour les capteurs sans données, pour que les démos restent lisibles

Structure du projet
------------------

- `app.py` — point d'entrée Flask, charge `.env` et enregistre les blueprints
- `routes/` — routes HTTP : `dashboard.py`, `kpis.py`, `alerts.py`
- `services/` — logique métier :
  - `data_source.py` — bascule CSV / PostgreSQL, point d'entrée unique pour charger capteurs, types de mesure et mesures
  - `chart_service.py` — construction des séries par cuve pour les graphiques
  - `kpi_service.py` — calcul des KPI
  - `alert_service.py` — génération des alertes
- `config/database.py` — connexion PostgreSQL (`psycopg2`), configurée via variables d'environnement
- `db/` — fixtures CSV pour le mode démo : `sensors.csv`, `measurement_types.csv`, `measurements.csv`
- `templates/dashboard.html` — page unique du tableau de bord
- `static/` — CSS et JS du dashboard (Chart.js)

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

Par défaut (sans `.env` ou avec `USE_POSTGRES` absent/`false`), l'application lit les fichiers CSV dans `db/`. Modifiez ou remplacez ces fichiers pour changer les données de démonstration.

Connecter la base PostgreSQL (temps réel)
----------------------------------------

Cette section explique **tout ce qu'il faut faire, dans l'ordre**, pour brancher le dashboard sur la base PostgreSQL existante et obtenir des valeurs en temps réel.

### Étape 0 — Changer le mot de passe de la base (important)

Un ancien mot de passe de connexion à cette base a été trouvé commité en clair dans l'historique Git du dépôt (fichiers `.env` et `config/database.py`). Il a été retiré du code et purgé de l'historique, mais **si ce mot de passe est encore actif côté serveur PostgreSQL, il doit être changé avant toute mise en production**, car il a pu être exposé publiquement sur GitHub. Cette étape est indépendante du reste — faites-la avec votre administrateur base de données si ce n'est pas déjà fait.

```sql
ALTER USER otbiread WITH PASSWORD 'un_nouveau_mot_de_passe_fort';
```

Adaptez le nom du rôle à votre environnement.

### Étape 1 — Récupérer les identifiants de connexion

Demandez (ou retrouvez) ces informations auprès de la personne qui gère la base :

- Hôte / IP du serveur PostgreSQL (ex. `172.23.220.11`)
- Port (souvent `5432`, mais peut être personnalisé, ex. `5050`)
- Nom de la base (ex. `iotsensors`)
- Utilisateur et mot de passe **en lecture seule** (voir [Sécurité](#sécurité))

### Étape 2 — Vérifier que le schéma de la base correspond à ce qu'attend l'application

L'application interroge trois tables : `sensors`, `measurement_types`, `measurements`. Connectez-vous à la base (via `psql` ou un client comme DBeaver/pgAdmin) et vérifiez qu'elles existent avec ces colonnes :

```sql
-- Lister les colonnes réelles de chaque table
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('sensors', 'measurement_types', 'measurements')
ORDER BY table_name, ordinal_position;
```

Colonnes attendues :

| Table | Colonnes |
|---|---|
| `sensors` | `id` (uuid), `eui64` (text), `name` (text), `tank` (text), `enabled` (boolean), `metadata` (jsonb), `display_order` (int) |
| `measurement_types` | `id` (int), `code` (text), `unit` (text), `value_domain` (text), `description` (text) |
| `measurements` | `time` (timestamptz), `sensor_id` (uuid), `measurement_type_id` (int), `statistic_id` (int), `value_num` (numeric), `internal_count` (int) |

Si vos noms de table/colonnes diffèrent, adaptez les requêtes SQL dans `services/data_source.py` (fonctions `load_sensors`, `load_measurement_types`, `load_measurements`) en conséquence — c'est le seul fichier à modifier.

Pour de bonnes performances sur une base volumineuse, assurez-vous qu'un index existe sur `measurements(time)` (le dashboard filtre systématiquement sur une fenêtre temporelle récente) :

```sql
CREATE INDEX IF NOT EXISTS idx_measurements_time ON measurements (time DESC);
```

### Étape 3 — Créer le fichier `.env`

À la racine du projet (à côté de `app.py`), créez un fichier nommé `.env` (il est déjà exclu de Git via `.gitignore`, il ne sera donc jamais commité) :

```ini
USE_POSTGRES=true

PG_HOST=172.23.220.11
PG_PORT=5050
PG_DATABASE=iotsensors
PG_USER=otbiread
PG_PASSWORD=le_nouveau_mot_de_passe

# Optionnel : fenêtre de données considérée comme "temps réel", en minutes (défaut 60)
REALTIME_WINDOW_MINUTES=60
```

Ce fichier est lu automatiquement au démarrage de `app.py` grâce à `python-dotenv`. Vous pouvez aussi définir ces variables directement dans l'environnement du système/service si vous préférez ne pas utiliser de fichier `.env` (recommandé en production, voir [Sécurité](#sécurité)) :

```powershell
setx PG_HOST "172.23.220.11"
setx PG_PORT "5050"
setx PG_DATABASE "iotsensors"
setx PG_USER "otbiread"
setx PG_PASSWORD "le_nouveau_mot_de_passe"
setx USE_POSTGRES "true"
```
(`setx` nécessite d'ouvrir un nouveau terminal pour que les variables soient prises en compte.)

### Étape 4 — Installer les dépendances

`psycopg2-binary` et `python-dotenv` sont déjà listés dans `requirements.txt` :

```powershell
py -3 -m pip install -r requirements.txt
```

### Étape 5 — Tester la connexion isolément (recommandé avant de lancer le dashboard)

```powershell
py -3 -c "from config.database import get_connection; conn = get_connection(); print('Connexion OK'); conn.close()"
```

Si cette commande échoue, réglez le problème avant de continuer (voir [Dépannage](#dépannage)) — le dashboard échouera de la même façon sinon.

### Étape 6 — Lancer l'application

```powershell
py -3 app.py
```

Ouvrez http://127.0.0.1:5000 : le dashboard doit maintenant afficher les données réelles de la base, avec les cuves, capteurs et alertes issus de PostgreSQL. Les données se rafraîchissent automatiquement toutes les 5 secondes côté navigateur, et chaque requête recharge la fenêtre des `REALTIME_WINDOW_MINUTES` dernières minutes depuis la base.

### Étape 7 — Déploiement (écran d'atelier / production)

Le serveur de développement Flask (`app.run`) n'est pas fait pour tourner en continu. Pour un affichage permanent sur un écran :

```powershell
py -3 -m pip install waitress
py -3 -m waitress --listen=0.0.0.0:5000 app:app
```

(ou un serveur WSGI équivalent — Gunicorn sous Linux). Configurez ensuite le navigateur de l'écran en mode kiosque pointant vers `http://<ip-du-serveur>:5000`, et définissez les variables d'environnement PostgreSQL au niveau du service plutôt que dans un `.env` local.

Référence API
-------------

- `GET /` — page du tableau de bord (HTML)
- `GET /api/dashboard` — payload JSON consommé par le front-end (séries par cuve, résumé, process en cours)
- `GET /api/kpis` — résumé des KPI (JSON) : courant/température moyens, nombre de cuves/capteurs, détail par cuve
- `GET /api/alerts` — liste des alertes (JSON : niveau, message, cuve, capteur)

Modèle de données & format CSV
-----------------------------

Les fichiers CSV se trouvent dans `db/` et ont les formats suivants (identiques aux tables PostgreSQL décrites plus haut) :

- `sensors.csv` — métadonnées capteurs (id, eui64, name, tank, enabled, metadata, display_order)
- `measurement_types.csv` — id, code, unit, value_domain, description
- `measurements.csv` — time (ISO8601), sensor_id, measurement_type_id, statistic_id, value_num, internal_count

Conservez les timestamps en ISO8601 (idéalement avec fuseau horaire) pour éviter les problèmes de parsing.

Sécurité
-----------------------

- **Ne commitez jamais** de mot de passe ou de fichier `.env` — `.gitignore` exclut déjà `.env` et `__pycache__`.
- Utilisez un rôle PostgreSQL **en lecture seule** pour l'application, avec `SELECT` uniquement sur `sensors`, `measurement_types`, `measurements` :

```sql
CREATE ROLE dashboard_reader LOGIN PASSWORD 'mot_de_passe_fort';
GRANT CONNECT ON DATABASE iotsensors TO dashboard_reader;
GRANT USAGE ON SCHEMA public TO dashboard_reader;
GRANT SELECT ON sensors, measurement_types, measurements TO dashboard_reader;
```

- Changez régulièrement le mot de passe, et immédiatement si vous soupçonnez qu'il a fuité (voir Étape 0 ci-dessus).
- En production, préférez des variables d'environnement définies au niveau du service/OS plutôt qu'un fichier `.env` sur disque.

Dépannage
---------

- **`ModuleNotFoundError: psycopg2`** : lancez `py -3 -m pip install -r requirements.txt` (ou `pip install psycopg2-binary`).
- **`connection refused` / timeout** : vérifiez que `PG_HOST`/`PG_PORT` sont corrects et que le serveur applicatif peut atteindre la base (pare-feu, VPN, règles réseau). Testez avec `psql -h <host> -p <port> -U <user> -d <database>`.
- **`password authentication failed`** : le mot de passe dans `.env` ne correspond pas à celui de la base — vérifiez qu'il n'a pas été changé (voir Étape 0) et qu'il n'y a pas d'espace/guillemet parasite dans le fichier `.env`.
- **`permission denied for table ...`** : le rôle utilisé n'a pas de `SELECT` sur la table concernée — voir [Sécurité](#sécurité).
- **Dashboard vide malgré une connexion réussie** : la fenêtre `REALTIME_WINDOW_MINUTES` (60 minutes par défaut) ne contient peut-être aucune mesure récente — augmentez-la temporairement, ou vérifiez que la table `measurements` reçoit bien des données en continu.
- **`USE_POSTGRES=true` mais l'app lit toujours les CSV** : vérifiez que le fichier `.env` est bien à la racine du projet (à côté de `app.py`) et qu'il n'y a pas d'espace autour du `=`. Redémarrez l'application après toute modification du `.env` (il n'est lu qu'au démarrage).
- **Graphiques vides en mode CSV** : vérifiez que `db/measurements.csv` contient des lignes avec des timestamps ISO valides.
