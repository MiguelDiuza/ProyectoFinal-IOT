"""Historial de las series: InfluxDB (lo que guarda Telegraf) con respaldo en memoria.

Si InfluxDB no responde (por ejemplo, corriendo la API sola), se usan los últimos
eventos que la API recibió por MQTT, así el dashboard nunca queda en blanco.
"""
from __future__ import annotations

import logging
import time
from collections import deque

from influxdb_client.client.influxdb_client_async import InfluxDBClientAsync

from .config import Config

log = logging.getLogger("historial")
SERIES = ("lecturas", "pronostico", "imu", "ventilador", "vision")
TIPO_A_SERIE = {"lectura": "lecturas", "pronostico": "pronostico", "imu": "imu", "ventilador": "ventilador", "vision": "vision"}
MAX_PUNTOS = 1500
CAMPOS_IGNORADOS = {"result", "table", "_start", "_stop", "_time", "_measurement", "host", "topic"}


def _reducir(datos: list[dict]) -> list[dict]:
    if len(datos) <= MAX_PUNTOS:
        return datos
    paso = len(datos) / MAX_PUNTOS
    return [datos[int(i * paso)] for i in range(MAX_PUNTOS)]


def fila_a_evento(fila: dict) -> dict:
    ev: dict = {"t": int(fila["_time"].timestamp() * 1000)}
    probs = {}
    for k, v in fila.items():
        if k in CAMPOS_IGNORADOS or v is None:
            continue
        if k.startswith("probs_"):
            probs[k[6:]] = v
        else:
            ev[k] = v
    if probs:
        ev["probs"] = probs
    return ev


class Historial:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.memoria = {s: deque(maxlen=4000) for s in SERIES}
        self.alertas: deque[dict] = deque(maxlen=300)
        self.influx_ok = False
        self._cliente = InfluxDBClientAsync(url=cfg.influx_url, token=cfg.influx_token, org=cfg.influx_org, timeout=8000) if cfg.influx_token else None

    def guardar(self, ev: dict) -> None:
        if ev["tipo"] == "alerta":
            self.alertas.appendleft(ev)
        elif (serie := TIPO_A_SERIE.get(ev["tipo"])):
            self.memoria[serie].append(ev)

    async def comprobar(self) -> bool:
        if not self._cliente:
            self.influx_ok = False
        else:
            try:
                self.influx_ok = await self._cliente.ping()
            except Exception:  # noqa: BLE001 — cualquier fallo de red cuenta como caído
                self.influx_ok = False
        return self.influx_ok

    async def consultar(self, serie: str, minutos: int) -> list[dict]:
        desde = int(time.time() * 1000) - minutos * 60_000
        if self._cliente:
            try:
                return _reducir(await self._influx(serie, minutos))
            except Exception as e:  # noqa: BLE001
                log.warning("InfluxDB no respondió (%s); uso la memoria", e)
                self.influx_ok = False
        return _reducir([e for e in self.memoria[serie] if e["t"] >= desde])

    async def consultar_alertas(self, limite: int) -> list[dict]:
        if self.alertas or not self._cliente:
            return list(self.alertas)[:limite]
        try:
            filas = await self._influx("alertas", 1440)
            return sorted(filas, key=lambda a: a["t"], reverse=True)[:limite]
        except Exception:  # noqa: BLE001
            return []

    async def _influx(self, medida: str, minutos: int) -> list[dict]:
        flux = f'''
from(bucket: "{self.cfg.influx_bucket}")
  |> range(start: -{int(minutos)}m)
  |> filter(fn: (r) => r._measurement == "{medida}")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> group()
  |> sort(columns: ["_time"])
'''
        tablas = await self._cliente.query_api().query(flux)
        self.influx_ok = True
        return [fila_a_evento(r.values) for t in tablas for r in t.records]

    async def cerrar(self):
        if self._cliente:
            await self._cliente.close()
