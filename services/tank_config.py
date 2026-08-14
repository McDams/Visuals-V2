# =====================================================================================
# Configuration métier centralisée : tous les seuils et associations ajustables du projet
# sont ici, pour ne pas avoir à fouiller le code quand une valeur change.
# =====================================================================================

# Association physique capteur -> côté (gauche/droite) par cuve. La clé est comparée d'abord
# au "name" du capteur, puis à son "eui64" (utile pour KS2, dont les capteurs manuels n'ont
# pas de nom en base).
NODE_MAP = {
    "KS1": {"13": "left", "14": "left", "11": "right", "12": "right"},
    "KS2": {
        # Les capteurs manuels de KS2 n'ont pas de nom, seulement un eui64, et aucune
        # information gauche/droite réelle n'est disponible : ils sont répartis par
        # display_order (les deux plus petits = gauche, les deux plus grands = droite) comme
        # solution provisoire — à corriger dès que la disposition physique réelle est connue.
        "F4CE3615B2076C01": "left",   # display_order 6
        "F4CE36735C9A8290": "left",   # display_order 9
        "F4CE36AC7ADAD99C": "right",  # display_order 10
        "F4CE3672AAE9A258": "right",  # display_order 11
    },
    "KS3": {"15": "left", "16": "left", "17": "right", "18": "right"},
    "KS4": {"3": "left", "7": "left", "1": "right", "2": "right"},
}

# Noms d'affichage forcés par cuve (clé = "name" OU "eui64" du capteur, comme NODE_MAP).
# Provisoire : les capteurs de KS2 n'ont pas de nom lisible en base (seulement un eui64), on
# les renomme donc côté droit A/B et côté gauche C/D pour l'affichage. À retirer/ajuster quand
# les vrais noms seront disponibles.
SENSOR_DISPLAY_NAMES = {
    "KS2": {
        "F4CE36AC7ADAD99C": "A",  # droite
        "F4CE3672AAE9A258": "B",  # droite
        "F4CE3615B2076C01": "C",  # gauche
        "F4CE36735C9A8290": "D",  # gauche
    },
}


def display_name(tank, sensor):
    """Nom lisible d'un capteur pour l'affichage : d'abord un éventuel alias forcé
    (SENSOR_DISPLAY_NAMES, cherché par name puis eui64), sinon le name, sinon l'id."""
    overrides = SENSOR_DISPLAY_NAMES.get(tank, {})
    name = (sensor.get("name") or "").strip()
    eui64 = (sensor.get("eui64") or "").strip()
    if name in overrides:
        return overrides[name]
    if eui64 in overrides:
        return overrides[eui64]
    return sensor.get("name") or sensor.get("id") or "Capteur inconnu"

# Codes de mesure porteurs d'une valeur de COURANT. D'après les descriptions de
# measurement_types, "current_measured" est spécifique à l'automate, tandis que les capteurs
# individuels remontent sous le code générique "current" ("sensor supplied") — il faut
# accepter les deux, sinon les mesures des capteurs sont ignorées silencieusement.
CURRENT_CODES = {"current", "current_measured"}

# Codes de mesure porteurs d'une TENSION. Dans le schéma actuel, "voltage" ("Voltage from
# automaton if available") et "voltage_measured" ("Voltage measured automaton") viennent tous
# deux de l'automate et ne sont PAS interchangeables comme pour le courant : "voltage" peut
# porter une valeur brute/consigne parfois négative. Seul "voltage_measured" est une vraie
# mesure, c'est donc le seul utilisé partout où on affiche une tension.
VOLTAGE_CODES = {"voltage_measured"}

# Code de mesure de la consigne de courant de l'automate (sert à calculer une consigne
# attendue par capteur = consigne totale / nombre de capteurs réellement en marche).
CURRENT_SETPOINT_CODE = "current_setpoint"

# Code de mesure de la consigne de TENSION de l'automate ("Voltage setpoint automaton").
# Affichée telle quelle dans la colonne "Consigne" (elle ne change pas pendant le fonctionnement).
# Seuls les automates KS2 et KS4 la remontent aujourd'hui ; KS1/KS3 n'ont pas d'automate exploité.
VOLTAGE_SETPOINT_CODE = "voltage_setpoint"

# Une cuve/un côté est considéré à l'arrêt dès que son courant reste sous ce seuil pendant
# plus de STOP_DURATION_SECONDS.
STOP_CURRENT_THRESHOLD_A = 10.0
STOP_DURATION_SECONDS = 60

# Un capteur déclenche l'alerte "Pas de données récentes" dès que sa dernière mesure est plus
# ancienne que ce délai. À caler sur l'intervalle réel de remontée des capteurs + une marge
# pour la latence réseau/polling — trop court, et des capteurs sains déclencheront à tort.
SENSOR_STALE_SECONDS = 60

# Seuil d'alerte pour l'écart de courant, vérifié à la fois capteur-vs-moyenne-cuve et
# capteur-vs-moyenne-du-côté. Aligné à 10 A (l'écart autorisé métier) : en dessous, ce n'est
# pas considéré comme une alerte.
IMBALANCE_THRESHOLD_A = 10.0

# Seuil d'écart MAX entre les capteurs d'un même côté (max - min). Au-delà, le côté est signalé
# comme déséquilibré dans le tableau (pastille + valeurs en rouge). C'est l'indicateur "métier"
# demandé pour l'électroformage : un écart de répartition >10 A entre deux branches parallèles
# trahit un contact desserré, une anode décrochée ou un dépôt inégal.
SIDE_SPREAD_THRESHOLD_A = 10.0

# Tolérance (secondes) pour les brefs creux sous le seuil dus au bruit des ampérages : tant que
# l'écart ne repasse pas sous le seuil pendant PLUS de cette durée, l'alerte est considérée
# continue (le décompte "actif depuis X" ne se réinitialise pas). Évite le clignotement du
# message quand l'écart oscille légèrement autour de 10 A tout en restant globalement au-dessus.
IMBALANCE_GRACE_SECONDS = 60

# Seuil d'alerte "Courant élevé" (moyenne d'une cuve). Dimensionné pour le courant réel de
# production (les jobs tournent entre 75 et 200 A) — ne pas le rabaisser vers quelques ampères,
# ce n'était valable que pour les données de démo CSV synthétiques (~4 A).
OVERCURRENT_THRESHOLD_A = 100.0

# Un trou plus long que ceci entre deux mesures réelles (non synthétiques) d'une cuve est
# compté comme une "coupure" pour le KPI affiché dans la vue historique.
OUTAGE_GAP_SECONDS = 30

# Échelle de courant (A) fixe et partagée par tous les graphiques de cuve, pour que la
# sévérité se lise pareil d'une cuve à l'autre. La ligne de l'automate utilise son propre axe
# secondaire car elle remonte un courant global bien plus grand que les capteurs individuels.
CHART_CURRENT_AXIS_MAX = 220

# Plages de courant servant à détecter automatiquement le job en cours (à partir du courant
# total de la cuve — la somme des courants des capteurs, qui reconstitue le courant de
# l'automate puisqu'il est redistribué aux capteurs) et la durée max autorisée avant que
# l'alerte "Temps de production" se déclenche.
JOBS = [
    {"name": "Porteur", "current_min": 75.0, "current_max": 105.0, "max_duration_hours": 16},
    {"name": "Cliché", "current_min": 160.0, "current_max": 200.0, "max_duration_hours": 2},
]

# Surveillance du pH non branchée pour l'instant : ni le CSV de démo ni le schéma documenté
# n'ont de code de mesure pH. Renseigner ces trois valeurs (code + plage acceptable) pour
# activer l'alerte "Alerte pH" (voir README).
PH_MEASUREMENT_CODE = None
PH_MIN = None
PH_MAX = None


def get_node(tank, sensor):
    """Renvoie le côté ("left"/"right") d'un capteur pour une cuve, ou None si non mappé.

    `sensor` est le dict du capteur ; on cherche d'abord par son nom, puis par son eui64
    (pour les capteurs sans nom).
    """
    node_map = NODE_MAP.get(tank, {})
    name = (sensor.get("name") or "").strip()
    eui64 = (sensor.get("eui64") or "").strip()
    return node_map.get(name) or node_map.get(eui64)
