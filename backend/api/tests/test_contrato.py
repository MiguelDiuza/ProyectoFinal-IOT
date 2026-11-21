import json

from app.config import Config
from app.contrato import normalizar

CFG = Config()


def n(tema, d):
    return normalizar(tema, json.dumps(d).encode() if not isinstance(d, bytes) else d, CFG, ahora_ms=1000)


def test_lectura_calcula_estado_si_falta():
    ev = n("bodega1/lecturas", {"temperatura": 26.0, "humedad": 55})
    assert ev == {"tipo": "lectura", "t": 1000, "dispositivo": "esp32-01", "temperatura": 26.0, "humedad": 55.0, "estado": "ALERTA"}


def test_lectura_sin_humedad_se_descarta():
    assert n("bodega1/lecturas", {"temperatura": 22}) is None
    assert n("bodega1/lecturas", b"no es json") is None
    assert n("bodega1/lecturas", {"temperatura": "22", "humedad": 50}) is None


def test_ventilador_confianza_desde_probs():
    ev = n("bodega1/ia/ventilador", {"clase": "normal", "probs": {"normal": 0.8, "obstruido": 0.2}, "dsp_ms": 4})
    assert ev["clase"] == "normal" and ev["confianza"] == 0.8 and ev["dsp_ms"] == 4


def test_imu_requiere_acelerometro():
    assert n("bodega1/imu", {"gx": 1}) is None
    ev = n("bodega1/imu", {"ax": 0.1, "ay": 0, "az": 9.8, "gz": 2, "vib_rms": 0.03})
    assert ev["az"] == 9.8 and ev["gz"] == 2 and "gx" not in ev


def test_estado_del_dispositivo_y_temas_ajenos():
    assert normalizar("bodega1/estado/esp32-01", b"offline", CFG, 5)["conectado"] is False
    assert n("otro/lecturas", {"temperatura": 1, "humedad": 1}) is None
    assert n("bodega1/desconocido", {}) is None
