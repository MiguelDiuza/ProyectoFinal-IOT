# Lambda "bodega-api" (Python 3.12, rol LabRole) detrás de API Gateway (HTTP API).
# Reemplaza a la de la Actividad 3: mantiene sus rutas y agrega GET /dashboard.
#   GET  /dashboard?minutos=30   -> lecturas + cámara + alarmas (carga inicial del dashboard)
#   GET  /dashboard?desde=<ms>   -> solo lo nuevo desde ese instante (el dashboard pregunta cada 5 s)
#   GET  /lecturas?horas=1       -> lecturas en JSON (compatible con la Actividad 3)
#   GET  /lecturas/csv?horas=24  -> lecturas en CSV (botón "Descargar CSV")
#   POST /led  {"estado":"ON"}   -> publica ON/OFF en bodega1/led (actuador del ESP32)
#
# Variables de entorno (Configuración -> Variables de entorno de la Lambda):
#   TABLA          tabla de DynamoDB (por defecto bodega-lecturas)
#   ID_LECTURAS    valor de "dispositivo" de las lecturas del ESP32 (por defecto bodega-esp32)
#   ID_CAMARA      valor de "dispositivo" de la ESP32-CAM          (por defecto esp32cam-01)
#   ID_ALERTAS     valor de "dispositivo" de las alarmas guardadas (por defecto alertas)
#   IOT_ENDPOINT   https://<id>-ats.iot.us-east-1.amazonaws.com (IoT Core -> Configuración)
# Rol: LabRole (Learner Lab). Clave de la tabla: dispositivo (String) + ts (Number, ms).

import base64
import json
import os
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

TABLA = os.environ.get("TABLA", "bodega-lecturas")
ID_LECTURAS = os.environ.get("ID_LECTURAS", "bodega-esp32")
ID_CAMARA = os.environ.get("ID_CAMARA", "esp32cam-01")
ID_ALERTAS = os.environ.get("ID_ALERTAS", "alertas")
IOT_ENDPOINT = os.environ.get("IOT_ENDPOINT", "")

MAX_MINUTOS = 24 * 60
MAX_ITEMS = 2000          # tope por consulta para no exceder los 6 MB de respuesta de Lambda

_tabla = None
_iot = None


def tabla():
    global _tabla
    if _tabla is None:
        _tabla = boto3.resource("dynamodb").Table(TABLA)
    return _tabla


def iot():
    global _iot
    if _iot is None:
        _iot = boto3.client("iot-data", endpoint_url=IOT_ENDPOINT) if IOT_ENDPOINT else boto3.client("iot-data")
    return _iot


CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}


def respuesta(codigo, cuerpo, tipo="application/json", extra=None):
    headers = {**CORS, "Content-Type": tipo, "Cache-Control": "no-store"}
    if extra:
        headers.update(extra)
    if not isinstance(cuerpo, str):
        cuerpo = json.dumps(cuerpo, ensure_ascii=False)
    return {"statusCode": codigo, "headers": headers, "body": cuerpo}


def a_json(v):
    """DynamoDB devuelve Decimal (también dentro de mapas y listas): se pasa a int/float."""
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, dict):
        return {k: a_json(x) for k, x in v.items()}
    if isinstance(v, list):
        return [a_json(x) for x in v]
    return v


def consultar(dispositivo, desde_ms, limite=MAX_ITEMS, recientes_primero=False):
    """Items de un dispositivo con ts > desde_ms, ordenados por tiempo (ascendente por defecto)."""
    params = {
        "KeyConditionExpression": Key("dispositivo").eq(dispositivo) & Key("ts").gt(int(desde_ms)),
        "ScanIndexForward": not recientes_primero,
    }
    items = []
    while len(items) < limite:
        params["Limit"] = limite - len(items)
        r = tabla().query(**params)
        items += r["Items"]
        if "LastEvaluatedKey" not in r:
            break
        params["ExclusiveStartKey"] = r["LastEvaluatedKey"]
    items = [a_json(i) for i in items]
    return list(reversed(items)) if recientes_primero else items


def numero(params, nombre, defecto, minimo, maximo):
    try:
        v = float(params.get(nombre, defecto))
    except (TypeError, ValueError):
        raise ValueError(f"'{nombre}' debe ser un número")
    if not (minimo <= v <= maximo):
        raise ValueError(f"'{nombre}' debe estar entre {minimo} y {maximo}")
    return v


def dashboard(params):
    ahora = int(time.time() * 1000)
    if "desde" in params:
        desde = numero(params, "desde", 0, ahora - MAX_MINUTOS * 60000, ahora + 60000)
        desde_alertas = desde
    else:
        minutos = numero(params, "minutos", 30, 1, MAX_MINUTOS)
        desde = ahora - minutos * 60000
        desde_alertas = ahora - 24 * 3600 * 1000  # las alarmas de las últimas 24 h, para el historial
    return {
        "ahora": ahora,
        "lecturas": consultar(ID_LECTURAS, desde),
        "camara": consultar(ID_CAMARA, desde, limite=200, recientes_primero=True),
        "alertas": consultar(ID_ALERTAS, desde_alertas, limite=100, recientes_primero=True),
    }


def csv_lecturas(horas):
    # Mismos nombres que publica esp32/bodega_final/bodega_final.ino
    cols = ["fecha", "temperatura", "humedad", "estado", "t_pred", "h_pred", "estado_futuro",
            "alerta_anticipada", "vent_clase", "vent_confianza", "vent_falla", "rms_acc", "rms_giro", "led"]
    lineas = [",".join(cols)]
    for f in consultar(ID_LECTURAS, time.time() * 1000 - horas * 3600000, limite=20000):
        # ts (UTC, ms) -> hora de Colombia (UTC-5)
        fecha = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(f["ts"] / 1000 - 5 * 3600))
        lineas.append(",".join([fecha] + ["" if f.get(c) is None else str(f.get(c)) for c in cols[1:]]))
    return "\n".join(lineas)


def lambda_handler(event, context):
    metodo = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    ruta = event.get("rawPath", "/").rstrip("/")
    params = event.get("queryStringParameters") or {}

    if metodo == "OPTIONS":
        return respuesta(204, "")
    try:
        if metodo == "GET" and ruta.endswith("/dashboard"):
            return respuesta(200, dashboard(params))

        if metodo == "GET" and ruta.endswith("/lecturas"):
            horas = numero(params, "horas", 1, 0.001, 24)
            return respuesta(200, consultar(ID_LECTURAS, time.time() * 1000 - horas * 3600000))

        if metodo == "GET" and ruta.endswith("/csv"):
            horas = numero(params, "horas", 24, 0.01, 168)
            return respuesta(200, csv_lecturas(horas), "text/csv; charset=utf-8",
                             {"Content-Disposition": 'attachment; filename="lecturas_bodega.csv"'})

        if metodo == "POST" and ruta.endswith("/led"):
            cuerpo = event.get("body") or "{}"
            if event.get("isBase64Encoded"):
                cuerpo = base64.b64decode(cuerpo).decode()
            try:
                estado = str(json.loads(cuerpo).get("estado", "")).upper()
            except (ValueError, AttributeError):
                estado = ""
            if estado not in ("ON", "OFF"):
                return respuesta(400, {"error": "El cuerpo debe ser {\"estado\": \"ON\"} o {\"estado\": \"OFF\"}"})
            iot().publish(topic="bodega1/led", qos=1, payload=estado)
            return respuesta(200, {"ok": True, "led": estado})
    except ValueError as e:
        return respuesta(400, {"error": str(e)})

    return respuesta(404, {"error": f"Ruta no encontrada: {metodo} {ruta or '/'}"})
