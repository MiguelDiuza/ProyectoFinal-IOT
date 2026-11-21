"""Simulador del ESP32 y la ESP32-CAM de la bodega (para probar sin hardware).

Publica exactamente los temas de docs/contrato-mqtt.md siguiendo un guion de 3 minutos
que pasa por todas las alarmas:

    0:00  todo normal
    0:30  la humedad empieza a subir -> el pronóstico TinyML avisa ANTES de salir del rango
    1:05  la humedad real pasa de 65 %
    1:15  ventilador desbalanceado (moneda en el aspa)
    1:40  ventilador obstruido
    2:00  la cámara detecta moho en el grano
    2:20  recuperación

Uso:
    pip install paho-mqtt
    python simular_bodega.py                      # lee usuario y clave de backend/.env
    python simular_bodega.py --host 192.168.1.50 --usuario esp32 --clave xxx --velocidad 2
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
import urllib.request
from pathlib import Path

import paho.mqtt.client as mqtt

CLASES_VENT = ["apagado", "desbalanceado", "normal", "obstruido"]  # orden alfabético, como Edge Impulse
DURACION = 180


def leer_env() -> dict:
    env = Path(__file__).resolve().parents[1] / ".env"
    datos = {}
    if env.exists():
        for linea in env.read_text(encoding="utf-8").splitlines():
            if "=" in linea and not linea.lstrip().startswith("#"):
                k, v = linea.split("=", 1)
                datos[k.strip()] = v.strip()
    return datos


def lerp(a, b, k):
    return a + (b - a) * max(0.0, min(1.0, k))


def probs(dominante: str, conf: float, clases: list[str]) -> dict:
    resto = [random.random() + 0.2 for _ in clases]
    total = sum(r for c, r in zip(clases, resto) if c != dominante)
    return {c: round(conf if c == dominante else (1 - conf) * r / total, 3) for c, r in zip(clases, resto)}


def guion(s: float) -> dict:
    """Valores objetivo para el segundo s del guion."""
    hum = 57.5 if s < 30 else lerp(57.5, 68.5, (s - 30) / 45) if s < 75 else lerp(68.5, 58, (s - 140) / 30) if s >= 140 else 68.5
    temp = 21.4 if s < 30 else lerp(21.4, 23.8, (s - 30) / 50) if s < 140 else lerp(23.8, 21.4, (s - 140) / 35)
    if 75 <= s < 100:
        vent = "desbalanceado"
    elif 100 <= s < 125:
        vent = "obstruido"
    else:
        vent = "normal"
    vision = "moho" if 120 <= s < 140 else "sano"
    return {"temp": temp, "hum": hum, "vent": vent, "vision": vision}


def main():
    env = leer_env()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--puerto", type=int, default=1883)
    ap.add_argument("--usuario", default=env.get("MQTT_USER_ESP32", "esp32"))
    ap.add_argument("--clave", default=env.get("MQTT_PASS_ESP32", ""))
    ap.add_argument("--prefijo", default="bodega1")
    ap.add_argument("--velocidad", type=float, default=1.0, help="multiplica la velocidad del guion")
    ap.add_argument("--api", default="", help="URL de la API para enviar fotos, ej. http://localhost:8000")
    ap.add_argument("--fotos", default="", help="carpeta con JPEG: sano*.jpg y moho*.jpg")
    a = ap.parse_args()

    p = a.prefijo
    cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"simulador-{random.randint(0, 9999)}")
    cli.username_pw_set(a.usuario, a.clave)
    cli.will_set(f"{p}/estado/esp32-01", "offline", qos=1, retain=True)
    cli.connect(a.host, a.puerto, keepalive=30)
    cli.loop_start()
    cli.publish(f"{p}/estado/esp32-01", "online", qos=1, retain=True)
    print(f"Simulador conectado a {a.host}:{a.puerto} — guion de {DURACION} s (Ctrl+C para salir)")

    pub = lambda tema, d: cli.publish(f"{p}/{tema}", json.dumps(d))  # noqa: E731
    T, H = 21.4, 57.5
    inicio, tick = time.monotonic(), 0
    try:
        while True:
            s = ((time.monotonic() - inicio) * a.velocidad) % DURACION
            g = guion(s)

            # ---- Ventana de 2 s: IMU + modelo del ventilador ----
            vib = {"apagado": 0.002, "normal": 0.035, "desbalanceado": 0.11, "obstruido": 0.06}[g["vent"]]
            fase = time.monotonic() * 7
            pub("imu", {
                "dispositivo": "esp32-01",
                "ax": round(0.12 + math.sin(fase) * vib * 4 + random.gauss(0, vib), 3),
                "ay": round(-0.08 + math.cos(fase) * vib * 3 + random.gauss(0, vib), 3),
                "az": round(9.79 + random.gauss(0, vib * 2), 3),
                "gx": round(random.gauss(0, 30 * vib), 2), "gy": round(random.gauss(0, 30 * vib), 2),
                "gz": round(random.gauss(0, 12 * vib), 2), "vib_rms": round(vib * random.uniform(0.85, 1.15), 4),
            })
            conf = {"normal": random.uniform(0.62, 0.9), "desbalanceado": random.uniform(0.78, 0.97),
                    "obstruido": random.uniform(0.75, 0.95), "apagado": 1.0}[g["vent"]]
            pub("ia/ventilador", {"dispositivo": "esp32-01", "clase": g["vent"], "confianza": round(conf, 3),
                                  "probs": probs(g["vent"], conf, CLASES_VENT), "dsp_ms": 4, "red_ms": 1})

            # ---- Cada 10 s: DHT11 + pronóstico TinyML ----
            if tick % 5 == 0:
                T += (g["temp"] - T) * 0.5 + random.gauss(0, 0.05)
                H += (g["hum"] - H) * 0.5 + random.gauss(0, 0.2)
                estado = "OK" if 15 <= T <= 25 and 50 <= H <= 65 else "ALERTA"
                pub("lecturas", {"dispositivo": "esp32-01", "temperatura": round(T, 1), "humedad": round(H, 1), "estado": estado})
                fut = guion((s + 25) % DURACION)  # el modelo "ve" la tendencia de los próximos minutos
                tp = T + (fut["temp"] - T) * 0.8 + random.gauss(0, 0.1)
                hp = H + (fut["hum"] - H) * 0.8 + random.gauss(0, 0.3)
                pub("ia/pronostico", {"dispositivo": "esp32-01", "temperatura_pred": round(tp, 1), "humedad_pred": round(hp, 1),
                                      "horizonte_min": 5, "alerta": not (15 <= tp <= 25 and 50 <= hp <= 65)})
                print(f"[{int(s):3d}s] T={T:.1f} H={H:.1f} pron=({tp:.1f}, {hp:.1f}) vent={g['vent']} cam={g['vision']}")

            # ---- Cada 10 s: ESP32-CAM ----
            if tick % 5 == 2:
                cv = random.uniform(0.86, 0.97) if g["vision"] == "sano" else random.uniform(0.8, 0.93)
                enviar_foto(a, g["vision"], cv) or pub("ia/vision", {
                    "dispositivo": "esp32cam-01", "clase": g["vision"], "confianza": round(cv, 3),
                    "probs": probs(g["vision"], cv, ["sano", "moho", "broca"])})

            tick += 1
            time.sleep(2 / a.velocidad)
    except KeyboardInterrupt:
        pass
    finally:
        cli.publish(f"{p}/estado/esp32-01", "offline", qos=1, retain=True).wait_for_publish(2)
        cli.loop_stop()
        cli.disconnect()


def enviar_foto(a, clase: str, conf: float) -> bool:
    """Si hay --api y --fotos, envía una foto por HTTP como lo haría la ESP32-CAM."""
    if not (a.api and a.fotos):
        return False
    opciones = sorted(Path(a.fotos).glob(f"{clase}*.jpg"))
    if not opciones:
        return False
    url = f"{a.api.rstrip('/')}/api/camara?clase={clase}&confianza={conf:.3f}&dispositivo=esp32cam-01"
    req = urllib.request.Request(url, data=random.choice(opciones).read_bytes(), headers={"Content-Type": "image/jpeg"})
    try:
        urllib.request.urlopen(req, timeout=5).read()
        return True
    except OSError as e:
        print("No se pudo enviar la foto:", e)
        return False


if __name__ == "__main__":
    main()
