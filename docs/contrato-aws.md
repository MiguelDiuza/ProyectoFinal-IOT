# Contrato de datos en AWS: dispositivos ↔ IoT Core ↔ DynamoDB ↔ dashboard

Lo que publica [`esp32/bodega_final`](../esp32/bodega_final/bodega_final.ino) y cómo lo usa el
dashboard en S3. La hora la pone IoT Core (`timestamp()` en la regla), en milisegundos.

| Tema | Quién | Cuándo | Destino (`dispositivo` en DynamoDB) |
|---|---|---|---|
| `bodega1/lecturas` | ESP32 | cada 10 s | DynamoDB (`bodega-esp32`) |
| `bodega1/alertas` | ESP32 / ESP32-CAM | solo cuando aparece una alarma | Lambda `bodega-alertas` → Telegram, y DynamoDB (`alertas`) |
| `bodega1/camara` | ESP32-CAM | cada foto clasificada | DynamoDB (`bodega1-camara`) |
| `bodega1/led` | Lambda `bodega-api` | al pulsar en el dashboard o desde MCP | ESP32 (texto `ON` / `OFF`) |

## `bodega1/lecturas` (sensores + predicciones)

```json
{ "dispositivo": "bodega-esp32", "temperatura": 22.4, "humedad": 58.1, "estado": "OK", "led": "OFF",
  "t_pred": 23.1, "h_pred": 66.4, "estado_futuro": "ALERTA", "alerta_anticipada": true,
  "vent_clase": "normal", "vent_confianza": 0.91, "vent_falla": false, "rms_acc": 0.03, "rms_giro": 0.01 }
```

`t_pred`, `h_pred`, `estado_futuro` y `alerta_anticipada` aparecen cuando el modelo T/H ya tiene
4 minutos de lecturas. En el dashboard: clima, pronóstico a 5 min, estado del ventilador, RMS del
acelerómetro (`rms_acc`, m/s²) y del giroscopio (`rms_giro`, rad/s) y el estado del actuador (`led`).

## `bodega1/alertas`

```json
{ "dispositivo": "bodega-esp32", "tipo": "falla_ventilador", "mensaje": "Falla en el ventilador: desbalanceado (confianza 91 %, ...)" }
```

| `tipo` | En el dashboard | Se da por resuelta cuando |
|---|---|---|
| `alerta_anticipada` | Pronóstico, aviso | el pronóstico vuelve a `OK` |
| `alerta_th` | Ambiente, crítica | la lectura y el pronóstico vuelven a `OK` |
| `falla_ventilador` | Ventilador, crítica | el ventilador deja de estar `desbalanceado`/`obstruido` |
| `grano_defectuoso` | Cámara, aviso | la cámara vuelve a ver grano `sano` |

El ESP32 solo avisa cuando la alarma aparece; el dashboard la marca como resuelta mirando los datos.

## `bodega1/camara` (ESP32-CAM, `esp32cam/camara_bodega`)

```json
{ "dispositivo": "bodega1-camara", "epoch": 1795577251, "clase": "sano", "confianza": 0.953,
  "prob_negro": 0.043, "prob_partido": 0.005, "prob_sano": 0.953, "dsp_ms": 28, "inferencia_ms": 9015 }
```

`clase` es `incierto` si ninguna clase llega a 0,60. `negro` y `partido` con confianza ≥ 0,80
cuentan como grano defectuoso; en ese caso la cámara también publica
`{"tipo": "grano_defectuoso", "mensaje": "..."}` en `bodega1/alertas` (máximo una vez por minuto).

## API del dashboard (API Gateway → Lambda `bodega-api`)

| Ruta | Respuesta |
|---|---|
| `GET /dashboard?minutos=30` | `{ "ahora", "lecturas": [...], "camara": [...], "alertas": [...] }` (items de DynamoDB) |
| `GET /dashboard?desde=<ms>` | lo mismo, solo lo posterior a `desde` (el dashboard pregunta cada 5 s) |
| `GET /lecturas?horas=1` | lecturas en JSON (como en la Act. 3) |
| `GET /lecturas/csv?horas=24` | CSV |
| `POST /led` con `{"estado":"ON"}` | publica `ON`/`OFF` en `bodega1/led` |
