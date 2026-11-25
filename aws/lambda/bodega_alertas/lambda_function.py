"""
Lambda bodega-alertas (Python 3.12, rol LabRole)

La invoca la regla de IoT "bodega_alertas_telegram" cada vez que el ESP32 publica
una alarma generada por la IA en el tema bodega1/alertas, por ejemplo:
  {"dispositivo":"bodega-esp32","tipo":"falla_ventilador","mensaje":"Falla en el ventilador: ..."}
y la envía al bot de Telegram.

Variables de entorno (Configuración -> Variables de entorno), NUNCA en el código:
  TELEGRAM_TOKEN    token del bot (@BotFather)
  TELEGRAM_CHAT_ID  id del chat que recibe las alarmas (.../getUpdates)
"""
import json
import os
import urllib.request

TOKEN = os.environ["TELEGRAM_TOKEN"]
CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]

ICONO = {"alerta_anticipada": "⚠️", "alerta_th": "🌡️", "falla_ventilador": "🌀", "grano_defectuoso": "☕"}


def lambda_handler(event, context):
    # event = JSON que publicó el dispositivo en bodega1/alertas (lo entrega la regla de IoT)
    tipo = event.get("tipo", "alerta")
    texto = f"{ICONO.get(tipo, '🔔')} Bodega de café — {tipo.replace('_', ' ')}\n{event.get('mensaje', '')}"
    datos = json.dumps({"chat_id": CHAT_ID, "text": texto}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/sendMessage",
                                 data=datos, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10)
    return {"ok": True}
