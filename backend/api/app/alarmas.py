"""Motor de alarmas: decide cuándo un resultado de los modelos de IA es una alarma.

Es lógica pura (sin red ni base de datos) para poder probarla. Recibe eventos normalizados
(ver contrato.py) y devuelve las transiciones de alarma:
    {"tipo": "alerta", "t", "id", "regla", "nivel", "estado": "activa" | "resuelta",
     "mensaje", "valor", "notificar": bool}
Usa histéresis (N eventos seguidos para activar o resolver) para no llenar Telegram de avisos.
"""
from __future__ import annotations

from .config import Config

MARGEN_CRITICO = 4.0  # °C o % HR fuera del rango a partir del cual el pronóstico es crítico
EVENTOS_ESP32 = {"lectura", "pronostico", "imu", "ventilador"}


def _f(x: float, dec: int = 1) -> str:
    return f"{x:.{dec}f}".replace(".", ",")


def _fuera(valor: float, rango: tuple[float, float]) -> float:
    """Distancia al rango (0 si está dentro)."""
    lo, hi = rango
    return lo - valor if valor < lo else valor - hi if valor > hi else 0.0


class MotorAlarmas:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._activas: dict[str, dict] = {}
        self._malas: dict[str, int] = {}
        self._buenas: dict[str, int] = {}
        self._ultimo_aviso: dict[str, int] = {}
        self._ultimo_esp32: int | None = None

    # ---------- API pública ----------
    def activas(self) -> list[dict]:
        return sorted(self._activas.values(), key=lambda a: a["t"], reverse=True)

    def procesar(self, ev: dict) -> list[dict]:
        t, tipo = ev["t"], ev["tipo"]
        salida: list[dict] = []
        if tipo in EVENTOS_ESP32:
            self._ultimo_esp32 = t
            salida += self._resolver("sin_datos", t, "El ESP32 volvió a enviar datos")
        regla = getattr(self, f"_regla_{tipo}", None)
        if regla:
            salida += regla(ev)
        return salida

    def revisar_silencio(self, ahora: int) -> list[dict]:
        if self._ultimo_esp32 is None or "sin_datos" in self._activas:
            return []
        seg = (ahora - self._ultimo_esp32) / 1000
        if seg <= self.cfg.silencio_seg:
            return []
        return self._activar("sin_datos", "sin_datos", "aviso", ahora,
                             f"El ESP32 no envía datos hace {int(seg)} s", seg)

    # ---------- Reglas ----------
    def _regla_ventilador(self, ev: dict) -> list[dict]:
        falla = ev["clase"] in self.cfg.clases_falla_ventilador and ev["confianza"] >= self.cfg.umbral_ventilador
        n = self.cfg.ventanas_ventilador
        msg = f"Ventilador {ev['clase']} (confianza {_f(ev['confianza'], 2)}): revisar aspas y rejilla"
        return self._histeresis("ventilador_falla", "ventilador", "critica", falla, n, n, ev["t"], msg,
                                ev["confianza"], "El ventilador volvió a funcionar normal")

    def _regla_pronostico(self, ev: dict) -> list[dict]:
        tp, hp, hz = ev["temperatura_pred"], ev["humedad_pred"], int(ev.get("horizonte_min", 5))
        dt, dh = _fuera(tp, self.cfg.rango_temp), _fuera(hp, self.cfg.rango_hum)
        partes = []
        if dh:
            lim = "máx." if hp > self.cfg.rango_hum[1] else "mín."
            ref = self.cfg.rango_hum[1] if hp > self.cfg.rango_hum[1] else self.cfg.rango_hum[0]
            partes.append(f"la humedad llegaría a {_f(hp)} % ({lim} {_f(ref, 0)} %)")
        if dt:
            lim = "máx." if tp > self.cfg.rango_temp[1] else "mín."
            ref = self.cfg.rango_temp[1] if tp > self.cfg.rango_temp[1] else self.cfg.rango_temp[0]
            partes.append(f"la temperatura llegaría a {_f(tp)} °C ({lim} {_f(ref, 0)} °C)")
        nivel = "critica" if max(dt, dh) >= MARGEN_CRITICO else "aviso"
        msg = f"Alerta anticipada: en {hz} min " + " y ".join(partes) if partes else ""
        return self._histeresis("pronostico", "pronostico", nivel, bool(partes), 1,
                                self.cfg.lecturas_para_resolver, ev["t"], msg, max(dt, dh),
                                "El pronóstico volvió al rango seguro")

    def _regla_lectura(self, ev: dict) -> list[dict]:
        t_, h_ = ev["temperatura"], ev["humedad"]
        fuera = bool(_fuera(t_, self.cfg.rango_temp) or _fuera(h_, self.cfg.rango_hum))
        msg = f"Bodega fuera de rango: temperatura {_f(t_)} °C, humedad {_f(h_)} %"
        return self._histeresis("ambiente", "ambiente", "critica", fuera, 1,
                                self.cfg.lecturas_para_resolver, ev["t"], msg, None,
                                "La bodega volvió al rango seguro")

    def _regla_vision(self, ev: dict) -> list[dict]:
        clase, conf = ev["clase"], ev["confianza"]
        mala = clase in self.cfg.clases_alerta_vision and conf >= self.cfg.umbral_vision
        salida = []
        ids = [i for i in self._activas if i.startswith("vision_")] + ([f"vision_{clase}"] if mala else [])
        for id_ in dict.fromkeys(ids):
            es_esta = id_ == f"vision_{clase}" and mala
            msg = f"La cámara detectó «{clase}» en el grano (confianza {_f(conf, 2)})"
            salida += self._histeresis(id_, "vision", "aviso", es_esta, 1, self.cfg.lecturas_para_resolver,
                                       ev["t"], msg, conf, f"La cámara ya no detecta «{id_[7:]}»")
        return salida

    # ---------- Mecánica ----------
    def _histeresis(self, id_, regla, nivel, malo, n_activar, n_resolver, t, msg, valor, msg_ok) -> list[dict]:
        if malo:
            self._buenas[id_] = 0
            self._malas[id_] = self._malas.get(id_, 0) + 1
            if id_ in self._activas:
                self._activas[id_].update(mensaje=msg, valor=valor, nivel=nivel)
                return []
            if self._malas[id_] >= n_activar:
                return self._activar(id_, regla, nivel, t, msg, valor)
            return []
        self._malas[id_] = 0
        if id_ not in self._activas:
            return []
        self._buenas[id_] = self._buenas.get(id_, 0) + 1
        if self._buenas[id_] >= n_resolver:
            return self._resolver(id_, t, msg_ok)
        return []

    def _activar(self, id_, regla, nivel, t, msg, valor) -> list[dict]:
        previo = self._ultimo_aviso.get(id_)
        notificar = previo is None or (t - previo) >= self.cfg.reaviso_min * 60_000
        if notificar:
            self._ultimo_aviso[id_] = t
        a = {"tipo": "alerta", "t": t, "id": id_, "regla": regla, "nivel": nivel, "estado": "activa",
             "mensaje": msg, "valor": valor, "notificar": notificar}
        self._activas[id_] = a
        return [dict(a)]

    def _resolver(self, id_, t, msg) -> list[dict]:
        a = self._activas.pop(id_, None)
        if a is None:
            return []
        self._buenas[id_] = self._malas[id_] = 0
        return [{"tipo": "alerta", "t": t, "id": id_, "regla": a["regla"], "nivel": "info", "estado": "resuelta",
                 "mensaje": msg, "valor": None, "notificar": a["notificar"]}]
