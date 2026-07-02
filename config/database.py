import psycopg2

def get_connection():

    return psycopg2.connect(
        host="172.23.220.11",
        database="iotsensors",
        user="otbiread",
        password="***REMOVED***",
        port="5050"
    )
