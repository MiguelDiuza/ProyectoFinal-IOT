"""Validación de los mensajes MQTT del ESP32 (contrato en docs/contrato-mqtt.md).

Convierte cada mensaje en un evento normalizado:
    {"tipo": "lectura" | "pronostico" | "imu" | "ventilador" | "vision" | "dispositivo", "t": ms, ...}
Los mensajes que no cumplen el contrato devuelven None (se descartan y se registran en el log).
"""
from __future__ import annotations

import json
import math
import time
from typing import Any

from .config import Config

TEMAS = {
    "lecturas": "lectura",
    "ia/pronostico": "pronostico",
    "imu": "imu",
    "ia/ventilador": "ventilador",
    "ia/vision": "vision",
}


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) else None


def _texto(v: Any, defecto: str = "", largo: int = 40) -> str:
    return str(v)[:largo] if isinstance(v, (str, int, float)) and str(v) else defecto


def _probs(v: Any) -> dict[str, float]:
    if not isinstance(v, dict):
        return {}
    salida = {}
    for k, p in list(v.items())[:12]:
        n = _num(p)
        if n is not None:
            salida[_texto(k, largo=24)] = round(min(max(n, 0.0), 1.0), 4)
    return salida


def estado_ambiente(t: float, h: float, cfg: Config) -> str:
    (t0, t1), (h0, h1) = cfg.rango_temp, cfg.rango_hum
    return "OK" if t0 <= t <= t1 and h0 <= h <= h1 else "ALERTA"


def normalizar(tema: str, payload: bytes, cfg: Config, ahora_ms: int | None = None) -> dict | None:
    t = ahora_ms if ahora_ms is not None else int(time.time() * 1000)
    prefijo = cfg.mqtt_prefijo + "/"
    if not tema.startswith(prefijo):
        return None
    sub = tema[len(prefijo):]

    if sub.startswith("estado/"):
        texto = payload.decode("utf-8", "replace").strip().lower()
        if texto not in ("online", "offline"):
            return None
        return {"tipo": "dispositivo", "t": t, "dispositivo": _texto(sub[7:]), "conectado": texto == "online"}

    tipo = TEMAS.get(sub)
    if tipo is None:
        return None
    try:
        d = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(d, dict):
        return None

    ev: dict[str, Any] = {"tipo": tipo, "t": t, "dispositivo": _texto(d.get("dispositivo"), "esp32cam-01" if tipo == "vision" else "esp32-01")}

    if tipo == "lectura":
        temp, hum = _num(d.get("temperatura")), _num(d.get("humedad"))
        if temp is None or hum is None:
            return None
        estado = d.get("estado") if d.get("estado") in ("OK", "ALERTA") else estado_ambiente(temp, hum, cfg)
        ev.update(temperatura=round(temp, 2), humedad=round(hum, 2), estado=estado)

    elif tipo == "pronostico":
        tp, hp = _num(d.get("temperatura_pred")), _num(d.get("humedad_pred"))
        if tp is None or hp is None:
            return None
        ev.update(temperatura_pred=round(tp, 2), humedad_pred=round(hp, 2),
                  horizonte_min=_num(d.get("horizonte_min")) or 5.0)
        if isinstance(d.get("alerta"), bool):
            ev["alerta"] = d["alerta"]

    elif tipo == "imu":
        ejes = {k: _num(d.get(k)) for k in ("ax", "ay", "az", "gx", "gy", "gz")}
        if any(ejes[k] is None for k in ("ax", "ay", "az")):
            return None
        ev.update({k: round(v, 4) for k, v in ejes.items() if v is not None})
        if (vib := _num(d.get("vib_rms"))) is not None:
            ev["vib_rms"] = round(vib, 4)

    else:  # ventilador | vision
        clase = _texto(d.get("clase"), largo=32)
        if not clase:
            return None
        probs = _probs(d.get("probs"))
        conf = _num(d.get("confianza"))
        if conf is None:
            conf = probs.get(clase)
        if conf is None:
            return None
        ev.update(clase=clase, confianza=round(min(max(conf, 0.0), 1.0), 4), probs=probs)
        for k in ("dsp_ms", "red_ms"):
            if (n := _num(d.get(k))) is not None:
                ev[k] = n
    return ev
