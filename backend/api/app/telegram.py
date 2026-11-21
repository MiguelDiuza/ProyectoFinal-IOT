"""Envío de alarmas a Telegram (Bot API). Sin token configurado, solo se registra en el log."""
from __future__ import annotations

import logging

import httpx

from .config import Config

log = logging.getLogger("telegram")
ICONO = {"critica": "🔴", "aviso": "🟠", "info": "🔵"}


def formatear(a: dict) -> str:
    if a["estado"] == "resuelta":
        return f"✅ <b>Resuelto</b> · Bodega 1\n{a['mensaje']}"
    nivel = "CRÍTICA" if a["nivel"] == "critica" else a["nivel"].upper()
    return f"{ICONO.get(a['nivel'], '⚪')} <b>Alarma {nivel}</b> · Bodega 1\n{a['mensaje']}"


class Telegram:
    def __init__(self, cfg: Config):
        self.token, self.chat = cfg.telegram_token, cfg.telegram_chat_id
        self.cliente = httpx.AsyncClient(timeout=10)

    @property
    def activo(self) -> bool:
        return bool(self.token and self.chat)

    async def enviar(self, alarma: dict, foto: bytes | None = None) -> bool:
        texto = formatear(alarma)
        if not self.activo:
            log.info("Telegram sin configurar; alarma: %s", texto.replace("\n", " | "))
            return False
        base = f"https://api.telegram.org/bot{self.token}"
        try:
            if foto:
                r = await self.cliente.post(f"{base}/sendPhoto",
                                            data={"chat_id": self.chat, "caption": texto, "parse_mode": "HTML"},
                                            files={"photo": ("foto.jpg", foto, "image/jpeg")})
            else:
                r = await self.cliente.post(f"{base}/sendMessage",
                                            json={"chat_id": self.chat, "text": texto, "parse_mode": "HTML"})
            if r.status_code != 200:
                log.warning("Telegram respondió %s: %s", r.status_code, r.text[:200])
            return r.status_code == 200
        except httpx.HTTPError as e:
            log.warning("No se pudo enviar a Telegram: %s", e)
            return False

    async def cerrar(self):
        await self.cliente.aclose()
