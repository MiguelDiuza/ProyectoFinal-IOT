"""Configuración del backend, leída de variables de entorno (ver backend/.env.example)."""
import os
from dataclasses import dataclass, field


def _lista(valor: str) -> list[str]:
    return [v.strip() for v in valor.split(",") if v.strip()]


def _rango(valor: str, defecto: tuple[float, float]) -> tuple[float, float]:
    try:
        a, b = (float(x) for x in valor.split(","))
        return (min(a, b), max(a, b))
    except (ValueError, AttributeError):
        return defecto


@dataclass(frozen=True)
class Config:
    # Rango seguro de la bodega de café pergamino
    rango_temp: tuple[float, float] = (15.0, 25.0)
    rango_hum: tuple[float, float] = (50.0, 65.0)

    # Reglas de alarma (contrato: docs/contrato-mqtt.md)
    umbral_ventilador: float = 0.60
    ventanas_ventilador: int = 3
    clases_falla_ventilador: tuple[str, ...] = ("desbalanceado", "obstruido")
    umbral_vision: float = 0.70
    clases_alerta_vision: tuple[str, ...] = ("moho", "broca", "defecto")
    lecturas_para_resolver: int = 2
    silencio_seg: int = 60
    reaviso_min: float = 5.0  # no repetir el aviso de la misma alarma antes de esto

    # Conexiones
    mqtt_host: str = "localhost"
    mqtt_puerto: int = 1883
    mqtt_usuario: str = ""
    mqtt_clave: str = ""
    mqtt_prefijo: str = "bodega1"
    influx_url: str = "http://localhost:8086"
    influx_token: str = ""
    influx_org: str = "bodega"
    influx_bucket: str = "bodega"
    telegram_token: str = ""
    telegram_chat_id: str = ""
    dir_fotos: str = "/data/fotos"
    cors_origenes: list[str] = field(default_factory=lambda: ["*"])

    @staticmethod
    def desde_entorno() -> "Config":
        e = os.getenv
        return Config(
            rango_temp=_rango(e("RANGO_TEMP", ""), (15.0, 25.0)),
            rango_hum=_rango(e("RANGO_HUM", ""), (50.0, 65.0)),
            umbral_ventilador=float(e("UMBRAL_VENTILADOR", "0.60")),
            ventanas_ventilador=int(e("VENTANAS_VENTILADOR", "3")),
            umbral_vision=float(e("UMBRAL_VISION", "0.70")),
            clases_alerta_vision=tuple(_lista(e("VISION_CLASES_ALERTA", "moho,broca,defecto"))),
            silencio_seg=int(e("SILENCIO_SEG", "60")),
            reaviso_min=float(e("REAVISO_MIN", "5")),
            mqtt_host=e("MQTT_HOST", "localhost"),
            mqtt_puerto=int(e("MQTT_PUERTO", "1883")),
            mqtt_usuario=e("MQTT_USUARIO", ""),
            mqtt_clave=e("MQTT_CLAVE", ""),
            mqtt_prefijo=e("MQTT_PREFIJO", "bodega1"),
            influx_url=e("INFLUX_URL", "http://localhost:8086"),
            influx_token=e("INFLUX_TOKEN", ""),
            influx_org=e("INFLUX_ORG", "bodega"),
            influx_bucket=e("INFLUX_BUCKET", "bodega"),
            telegram_token=e("TELEGRAM_TOKEN", ""),
            telegram_chat_id=e("TELEGRAM_CHAT_ID", ""),
            dir_fotos=e("DIR_FOTOS", "/data/fotos"),
            cors_origenes=_lista(e("CORS_ORIGENES", "*")),
        )
