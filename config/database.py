import os


def get_connection():
    """Ouvre une connexion à la base PostgreSQL à partir des variables d'environnement.

    L'import de psycopg2 est fait ici (et non en haut du fichier) pour que ce module reste
    importable en mode CSV, où psycopg2 n'est pas forcément installé : la connexion n'est
    tentée que si on l'appelle réellement (c.-à-d. en mode PostgreSQL).
    """
    import psycopg2

    return psycopg2.connect(
        host=os.environ.get("PG_HOST", "localhost"),
        database=os.environ.get("PG_DATABASE", "iotsensors"),
        user=os.environ.get("PG_USER", "user"),
        password=os.environ.get("PG_PASSWORD", ""),
        port=os.environ.get("PG_PORT", "5432"),
    )
