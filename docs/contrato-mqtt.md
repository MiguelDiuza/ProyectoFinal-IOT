# Contrato de datos: ESP32 ↔ backend ↔ dashboard

Este documento es el acuerdo entre el firmware (`esp32/bodega_final`, `esp32cam/`), el backend
(`backend/`) y el dashboard (`dashboard/`). Si el firmware publica con estos temas y campos,
todo lo demás (base de datos, Grafana, dashboard y alarmas por Telegram) funciona sin tocar código.

- Broker: Mosquitto, puerto **1883**, con usuario y clave (ver `backend/.env`).
- Prefijo de temas: **`bodega1`** (configurable con `MQTT_PREFIJO`).
- Todos los mensajes son **JSON** (UTF-8), salvo `bodega1/estado/<dispositivo>`.
- El servidor pone la hora de llegada: el ESP32 **no** necesita reloj (NTP) para publicar.
- Campos opcionales: si no se envían, el dashboard los oculta. Campos extra: se ignoran.

## Temas que publica el ESP32 (DHT11 + MPU6050)

### `bodega1/lecturas` — temperatura y humedad medidas (cada 10 s)

```json
{ "dispositivo": "esp32-01", "temperatura": 22.4, "humedad": 58.1, "estado": "OK" }
```

| Campo | Tipo | Notas |
|---|---|---|
| `temperatura` | número (°C) | obligatorio |
| `humedad` | número (% HR) | obligatorio |
| `estado` | `"OK"` \| `"ALERTA"` | opcional. Si falta, el backend lo calcula con el rango 15–25 °C y 50–65 % |
| `dispositivo` | texto | opcional (por defecto `esp32-01`) |

### `bodega1/ia/pronostico` — modelo TinyML de temperatura y humedad (cada 10 s)

Resultado del modelo que pronostica T y H a 5 minutos.

```json
{ "dispositivo": "esp32-01", "temperatura_pred": 23.1, "humedad_pred": 66.4, "horizonte_min": 5, "alerta": true }
```

| Campo | Tipo | Notas |
|---|---|---|
| `temperatura_pred` | número (°C) | obligatorio |
| `humedad_pred` | número (% HR) | obligatorio |
| `horizonte_min` | número | opcional (por defecto 5) |
| `alerta` | booleano | opcional: lo que decidió el ESP32 (LED de D2). El backend vuelve a evaluar el rango por su cuenta |

### `bodega1/imu` — acelerómetro y giroscopio (cada ventana de 2 s)

Resumen de la ventana que se le pasó al modelo del ventilador.

```json
{ "dispositivo": "esp32-01", "ax": 0.12, "ay": -0.08, "az": 9.79, "gx": 1.4, "gy": -0.6, "gz": 0.2, "vib_rms": 0.031 }
```

| Campo | Tipo | Notas |
|---|---|---|
| `ax`, `ay`, `az` | número (m/s²) | promedio de la ventana (mismas unidades del entrenamiento) |
| `gx`, `gy`, `gz` | número (°/s) | promedio de la ventana. La librería de Adafruit da rad/s: multiplicar por 57,2958 |
| `vib_rms` | número (m/s²) | opcional: RMS de la magnitud de la aceleración sin su media (intensidad de la vibración) |

### `bodega1/ia/ventilador` — modelo de Edge Impulse del ventilador (cada ventana de 2 s)

```json
{
  "dispositivo": "esp32-01",
  "clase": "desbalanceado",
  "confianza": 0.91,
  "probs": { "apagado": 0.0, "normal": 0.06, "desbalanceado": 0.91, "obstruido": 0.03 },
  "dsp_ms": 4,
  "red_ms": 1
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `clase` | `apagado` \| `normal` \| `desbalanceado` \| `obstruido` | obligatorio. `incierto` también vale (ninguna clase supera el umbral) |
| `confianza` | número 0–1 | obligatorio |
| `probs` | objeto clase → 0–1 | opcional, recomendado (el dashboard dibuja las barras) |
| `dsp_ms`, `red_ms` | número | opcional: tiempos de `resultado.timing.dsp` y `resultado.timing.classification` |

### `bodega1/estado/esp32-01` — conexión (texto plano, *retained*)

`online` al conectar y `offline` como *Last Will* (lo publica el broker si el ESP32 se cae).

## Lo que publica la ESP32-CAM

### `bodega1/ia/vision` — clasificación de imágenes

```json
{ "dispositivo": "esp32cam-01", "clase": "sano", "confianza": 0.93, "probs": { "sano": 0.93, "defecto": 0.07 } }
```

Las clases todavía no están definidas: el dashboard muestra cualquier clase. Las que generan
alarma se configuran en `backend/.env` con `VISION_CLASES_ALERTA` (por ejemplo `moho,broca,defecto`).

### Foto (opcional, por HTTP)

Para ver la imagen en el dashboard, la cámara envía el JPEG por HTTP. El backend guarda la foto,
publica la clasificación en `bodega1/ia/vision` y la manda por Telegram si genera alarma:

```
POST http://<servidor>:8000/api/camara?clase=sano&confianza=0.93&dispositivo=esp32cam-01
Content-Type: image/jpeg
<bytes del JPEG>
```

Responde `201 {"ok": true}`. Si la cámara ya publicó por MQTT, puede enviar solo la foto sin
`clase` y el backend la asocia a la última clasificación.

## Lo que publica el backend

### `bodega1/alertas` — alarmas generadas a partir de los modelos de IA

```json
{ "id": "ventilador_falla", "regla": "ventilador", "nivel": "critica", "estado": "activa",
  "mensaje": "Ventilador desbalanceado (confianza 0,91)", "valor": 0.91 }
```

`nivel`: `info` | `aviso` | `critica`. `estado`: `activa` | `resuelta`. Cada alarma activada o
resuelta también se envía a Telegram.

| Regla | Se activa cuando | Se resuelve cuando |
|---|---|---|
| `pronostico` | el modelo TinyML pronostica T o H fuera del rango seguro a 5 min | 2 pronósticos seguidos dentro del rango |
| `ambiente` | la lectura actual está fuera del rango | 2 lecturas seguidas dentro del rango |
| `ventilador` | `desbalanceado` u `obstruido` con confianza ≥ 0,60 en 3 ventanas seguidas (6 s) | 3 ventanas seguidas sin falla |
| `vision` | la cámara ve una clase de `VISION_CLASES_ALERTA` con confianza ≥ 0,70 | 2 imágenes seguidas sin esa clase |
| `sin_datos` | el ESP32 no publica nada en 60 s | vuelve a publicar |

## API HTTP del backend (puerto 8000)

| Método y ruta | Respuesta |
|---|---|
| `GET /api/salud` | `{ "ok": true, "mqtt": true, "influx": true, "telegram": false }` |
| `GET /api/estado` | último valor de cada serie + alarmas activas + configuración (rangos) |
| `GET /api/historial?serie=lecturas&minutos=60` | `{ "serie": "lecturas", "datos": [ {"t": 1732200000000, ...}, ... ] }` |
| `GET /api/alertas?limite=50` | `{ "datos": [ ...alarmas, la más reciente primero ] }` |
| `POST /api/camara` | ver arriba |
| `GET /api/camara/ultima.jpg` | la última foto (404 si no hay) |
| `WS /ws` | eventos en tiempo real: `{ "tipo": "lectura" \| "pronostico" \| "imu" \| "ventilador" \| "vision" \| "alerta" \| "dispositivo", "t": <ms>, ...campos }` |

Series de `historial`: `lecturas`, `pronostico`, `imu`, `ventilador`, `vision`.
`minutos` va de 1 a 1440. Errores: `{ "error": { "codigo": "SERIE_INVALIDA", "mensaje": "..." } }`.

## Ejemplo de publicación en el ESP32 (PubSubClient)

```cpp
// Al conectar: Last Will + online (retained)
mqtt.connect("esp32-01", MQTT_USER, MQTT_PASS, "bodega1/estado/esp32-01", 1, true, "offline");
mqtt.publish("bodega1/estado/esp32-01", "online", true);

// Resultado del modelo del ventilador
char json[256];
snprintf(json, sizeof(json),
  "{\"dispositivo\":\"esp32-01\",\"clase\":\"%s\",\"confianza\":%.3f,"
  "\"probs\":{\"apagado\":%.3f,\"normal\":%.3f,\"desbalanceado\":%.3f,\"obstruido\":%.3f},"
  "\"dsp_ms\":%d,\"red_ms\":%d}",
  clase, confianza, p[0], p[1], p[2], p[3], resultado.timing.dsp, resultado.timing.classification);
mqtt.publish("bodega1/ia/ventilador", json);
```

> El orden de `p[]` es el de `resultado.classification[c].label` (alfabético en Edge Impulse:
> apagado, desbalanceado, normal, obstruido). Lo más seguro es armar `probs` recorriendo las
> etiquetas, como hace `prueba_ventilador.ino`.

Para probar todo sin hardware: `python backend/simulador/simular_bodega.py` (publica todos estos temas).
