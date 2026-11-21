"""API de la bodega de café.

- Se suscribe a bodega1/# en Mosquitto, valida cada mensaje y lo reenvía al dashboard por WebSocket.
- Evalúa las alarmas de los modelos de IA y las notifica por Telegram (y las publica en bodega1/alertas,
  de donde Telegraf las guarda en InfluxDB).
- Sirve el historial (InfluxDB) y recibe las fotos de la ESP32-CAM.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import aiomqtt
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .alarmas import MotorAlarmas
from .config import Config
from .contrato import normalizar
from .historial import SERIES, Historial
from .telegram import Telegram

if sys.platform == "win32":  # aiomqtt necesita el selector de eventos en Windows
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("api")
MAX_FOTO = 2 * 1024 * 1024


def ahora_ms() -> int:
    return int(time.time() * 1000)


class Servicio:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.motor = MotorAlarmas(cfg)
        self.historial = Historial(cfg)
        self.telegram = Telegram(cfg)
        self.clientes: set[WebSocket] = set()
        self.ultimo: dict[str, dict] = {}
        self.dispositivos: dict[str, dict] = {}
        self.mqtt: aiomqtt.Client | None = None
        self.dir_fotos = Path(cfg.dir_fotos)
        self.dir_fotos.mkdir(parents=True, exist_ok=True)

    # ---------- difusión ----------
    async def difundir(self, ev: dict) -> None:
        if not self.clientes:
            return
        texto = json.dumps(ev, ensure_ascii=False)
        for ws in list(self.clientes):
            try:
                await ws.send_text(texto)
            except Exception:  # noqa: BLE001 — cliente cerrado
                self.clientes.discard(ws)

    async def procesar(self, ev: dict) -> None:
        if ev["tipo"] == "dispositivo":
            self.dispositivos[ev["dispositivo"]] = {"conectado": ev["conectado"], "t": ev["t"]}
        else:
            self.dispositivos[ev["dispositivo"]] = {"conectado": True, "t": ev["t"]}
            self.ultimo[ev["tipo"]] = ev
            self.historial.guardar(ev)
        await self.difundir(ev)
        for alarma in self.motor.procesar(ev):
            await self.emitir_alarma(alarma)

    async def emitir_alarma(self, a: dict) -> None:
        self.historial.guardar(a)
        await self.difundir(a)
        if self.mqtt:
            publicable = {k: v for k, v in a.items() if k not in ("tipo", "t", "notificar")}
            try:
                await self.mqtt.publish(f"{self.cfg.mqtt_prefijo}/alertas", json.dumps(publicable, ensure_ascii=False), qos=1)
            except aiomqtt.MqttError as e:
                log.warning("No se pudo publicar la alarma: %s", e)
        if a.get("notificar"):
            foto = None
            if a["regla"] == "vision" and a["estado"] == "activa" and (self.dir_fotos / "ultima.jpg").exists():
                foto = (self.dir_fotos / "ultima.jpg").read_bytes()
            asyncio.create_task(self.telegram.enviar(a, foto))

    # ---------- tareas de fondo ----------
    async def bucle_mqtt(self) -> None:
        while True:
            try:
                async with aiomqtt.Client(self.cfg.mqtt_host, self.cfg.mqtt_puerto,
                                          username=self.cfg.mqtt_usuario or None, password=self.cfg.mqtt_clave or None,
                                          identifier=f"api-bodega-{int(time.time())}") as cliente:
                    self.mqtt = cliente
                    await cliente.subscribe(f"{self.cfg.mqtt_prefijo}/#")
                    log.info("Conectado a MQTT %s:%s", self.cfg.mqtt_host, self.cfg.mqtt_puerto)
                    async for msg in cliente.messages:
                        ev = normalizar(str(msg.topic), bytes(msg.payload or b""), self.cfg, ahora_ms())
                        if ev:
                            await self.procesar(ev)
                        elif not str(msg.topic).endswith("/alertas"):
                            log.debug("Mensaje fuera de contrato en %s", msg.topic)
            except aiomqtt.MqttError as e:
                log.warning("MQTT desconectado (%s); reintento en 3 s", e)
            self.mqtt = None
            await asyncio.sleep(3)

    async def bucle_vigilancia(self) -> None:
        while True:
            await asyncio.sleep(5)
            for alarma in self.motor.revisar_silencio(ahora_ms()):
                await self.emitir_alarma(alarma)
            await self.historial.comprobar()

    def salud(self) -> dict:
        return {"ok": True, "mqtt": self.mqtt is not None, "influx": self.historial.influx_ok, "telegram": self.telegram.activo}


cfg = Config.desde_entorno()
servicio = Servicio(cfg)


@asynccontextmanager
async def ciclo_de_vida(_: FastAPI):
    tareas = [asyncio.create_task(servicio.bucle_mqtt()), asyncio.create_task(servicio.bucle_vigilancia())]
    await servicio.historial.comprobar()
    yield
    for t in tareas:
        t.cancel()
    await servicio.telegram.cerrar()
    await servicio.historial.cerrar()


app = FastAPI(title="Bodega de café — API IoT", version="1.0.0", lifespan=ciclo_de_vida)
app.add_middleware(CORSMiddleware, allow_origins=cfg.cors_origenes, allow_methods=["*"], allow_headers=["*"])


def error(status: int, codigo: str, mensaje: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"codigo": codigo, "mensaje": mensaje})


@app.exception_handler(HTTPException)
async def manejar_error(_: Request, exc: HTTPException):
    detalle = exc.detail if isinstance(exc.detail, dict) else {"codigo": "ERROR", "mensaje": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": detalle})


@app.get("/api/salud")
async def salud():
    return servicio.salud()


@app.get("/api/estado")
async def estado():
    foto = servicio.dir_fotos / "ultima.jpg"
    return {
        "t": ahora_ms(),
        "config": {
            "rango_temp": cfg.rango_temp, "rango_hum": cfg.rango_hum,
            "umbral_ventilador": cfg.umbral_ventilador, "umbral_vision": cfg.umbral_vision,
            "clases_falla_ventilador": cfg.clases_falla_ventilador, "clases_alerta_vision": cfg.clases_alerta_vision,
        },
        "ultimo": servicio.ultimo,
        "dispositivos": servicio.dispositivos,
        "alarmas_activas": servicio.motor.activas(),
        "foto": f"/api/camara/ultima.jpg?t={int(foto.stat().st_mtime * 1000)}" if foto.exists() else None,
        "servicios": servicio.salud(),
    }


@app.get("/api/historial")
async def historial(serie: str = Query(...), minutos: int = Query(60)):
    if serie not in SERIES:
        raise error(400, "SERIE_INVALIDA", f"Serie desconocida. Usa una de: {', '.join(SERIES)}")
    if not 1 <= minutos <= 1440:
        raise error(400, "RANGO_INVALIDO", "minutos debe estar entre 1 y 1440")
    return {"serie": serie, "minutos": minutos, "datos": await servicio.historial.consultar(serie, minutos)}


@app.get("/api/alertas")
async def alertas(limite: int = Query(50, ge=1, le=300)):
    return {"datos": await servicio.historial.consultar_alertas(limite)}


@app.post("/api/camara", status_code=201)
async def camara(request: Request, clase: str | None = None, confianza: float | None = None,
                 dispositivo: str = "esp32cam-01"):
    cuerpo = await request.body()
    if len(cuerpo) > MAX_FOTO:
        raise error(413, "FOTO_MUY_GRANDE", "La foto supera 2 MB")
    if not cuerpo.startswith(b"\xff\xd8"):
        raise error(422, "NO_ES_JPEG", "El cuerpo debe ser una imagen JPEG (Content-Type: image/jpeg)")
    t = ahora_ms()
    (servicio.dir_fotos / "ultima.jpg").write_bytes(cuerpo)
    await servicio.difundir({"tipo": "foto", "t": t, "dispositivo": dispositivo, "url": f"/api/camara/ultima.jpg?t={t}"})
    if clase is not None:
        if confianza is None or not 0 <= confianza <= 1:
            raise error(422, "CONFIANZA_INVALIDA", "confianza debe estar entre 0 y 1")
        payload = json.dumps({"dispositivo": dispositivo, "clase": clase[:32], "confianza": confianza})
        if servicio.mqtt:  # pasa por el broker: Telegraf lo guarda y la API lo procesa al recibirlo
            await servicio.mqtt.publish(f"{cfg.mqtt_prefijo}/ia/vision", payload, qos=1)
        else:
            ev = normalizar(f"{cfg.mqtt_prefijo}/ia/vision", payload.encode(), cfg, t)
            if ev:
                await servicio.procesar(ev)
    return {"ok": True}


@app.get("/api/camara/ultima.jpg")
async def ultima_foto():
    foto = servicio.dir_fotos / "ultima.jpg"
    if not foto.exists():
        raise error(404, "SIN_FOTO", "La cámara todavía no ha enviado fotos")
    return FileResponse(foto, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    servicio.clientes.add(websocket)
    try:
        while True:
            await websocket.receive_text()  # el dashboard no envía nada; esto detecta el cierre
    except WebSocketDisconnect:
        pass
    finally:
        servicio.clientes.discard(websocket)
