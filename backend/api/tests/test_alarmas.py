from app.alarmas import MotorAlarmas
from app.config import Config

CFG = Config()


def vent(clase, conf, t):
    return {"tipo": "ventilador", "t": t, "dispositivo": "esp32-01", "clase": clase, "confianza": conf, "probs": {}}


def pron(tp, hp, t):
    return {"tipo": "pronostico", "t": t, "dispositivo": "esp32-01", "temperatura_pred": tp, "humedad_pred": hp, "horizonte_min": 5}


def test_ventilador_requiere_ventanas_seguidas_para_activar():
    m = MotorAlarmas(CFG)
    assert m.procesar(vent("desbalanceado", 0.9, 0)) == []
    assert m.procesar(vent("desbalanceado", 0.9, 2000)) == []
    [a] = m.procesar(vent("desbalanceado", 0.9, 4000))
    assert a["id"] == "ventilador_falla" and a["estado"] == "activa" and a["nivel"] == "critica"
    assert "desbalanceado" in a["mensaje"] and a["notificar"]


def test_ventilador_baja_confianza_o_interrupcion_reinicia_la_cuenta():
    m = MotorAlarmas(CFG)
    m.procesar(vent("obstruido", 0.9, 0))
    m.procesar(vent("obstruido", 0.5, 2000))  # bajo el umbral 0.60
    m.procesar(vent("obstruido", 0.9, 4000))
    assert m.procesar(vent("obstruido", 0.9, 6000)) == []
    assert m.procesar(vent("obstruido", 0.9, 8000))[0]["estado"] == "activa"


def test_ventilador_se_resuelve_tras_ventanas_sin_falla():
    m = MotorAlarmas(CFG)
    for i in range(3):
        m.procesar(vent("obstruido", 0.95, i * 2000))
    assert m.procesar(vent("normal", 0.8, 6000)) == []
    assert m.procesar(vent("normal", 0.8, 8000)) == []
    [r] = m.procesar(vent("normal", 0.8, 10000))
    assert r["estado"] == "resuelta" and r["id"] == "ventilador_falla"
    assert m.activas() == []


def test_alarma_activa_no_se_repite():
    m = MotorAlarmas(CFG)
    for i in range(3):
        m.procesar(vent("obstruido", 0.95, i * 2000))
    assert m.procesar(vent("obstruido", 0.95, 8000)) == []
    assert len(m.activas()) == 1


def test_pronostico_fuera_de_rango_activa_alerta_anticipada():
    m = MotorAlarmas(CFG)
    [a] = m.procesar(pron(22.0, 67.3, 0))
    assert a["id"] == "pronostico" and a["estado"] == "activa"
    assert "humedad" in a["mensaje"].lower() and "5 min" in a["mensaje"]


def test_pronostico_muy_lejos_del_rango_es_critico():
    m = MotorAlarmas(CFG)
    [a] = m.procesar(pron(22.0, 72.0, 0))
    assert a["nivel"] == "critica"


def test_pronostico_se_resuelve_con_dos_dentro_del_rango():
    m = MotorAlarmas(CFG)
    m.procesar(pron(22.0, 67.0, 0))
    assert m.procesar(pron(22.0, 60.0, 10000)) == []
    [r] = m.procesar(pron(22.0, 60.0, 20000))
    assert r["estado"] == "resuelta"


def test_vision_clase_mala_con_confianza():
    m = MotorAlarmas(CFG)
    ev = {"tipo": "vision", "t": 0, "dispositivo": "esp32cam-01", "clase": "moho", "confianza": 0.85, "probs": {}}
    [a] = m.procesar(ev)
    assert a["id"] == "vision_moho" and a["regla"] == "vision"
    ev2 = dict(ev, clase="moho", confianza=0.5)
    m2 = MotorAlarmas(CFG)
    assert m2.procesar(ev2) == []


def test_lectura_fuera_de_rango():
    m = MotorAlarmas(CFG)
    [a] = m.procesar({"tipo": "lectura", "t": 0, "dispositivo": "esp32-01", "temperatura": 27.0, "humedad": 60.0, "estado": "ALERTA"})
    assert a["id"] == "ambiente" and "27" in a["mensaje"]


def test_silencio_del_esp32_y_recuperacion():
    m = MotorAlarmas(CFG)
    m.procesar(pron(22.0, 60.0, 0))
    assert m.revisar_silencio(30_000) == []
    [a] = m.revisar_silencio(61_000)
    assert a["id"] == "sin_datos" and a["estado"] == "activa"
    assert m.revisar_silencio(90_000) == []
    [r] = m.procesar(pron(22.0, 60.0, 95_000))
    assert r["id"] == "sin_datos" and r["estado"] == "resuelta"


def test_reactivacion_rapida_no_vuelve_a_notificar():
    m = MotorAlarmas(CFG)
    m.procesar(pron(22.0, 67.0, 0))
    m.procesar(pron(22.0, 60.0, 10_000))
    m.procesar(pron(22.0, 60.0, 20_000))
    [a] = m.procesar(pron(22.0, 67.0, 30_000))  # antes de REAVISO_MIN (5 min)
    assert a["estado"] == "activa" and a["notificar"] is False
