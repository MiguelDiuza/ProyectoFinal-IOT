# ☕ Bodega de café pergamino — IA en el borde (Edge AI) con ESP32

Proyecto final del curso **Inteligencia Artificial aplicada a Internet de las Cosas**
(Especialización en IA — Actividad 4: implementar un modelo de IA en un microcontrolador).

> 🚧 En construcción. Este README se va completando a medida que avanza el proyecto.

## Caso de uso

Una cooperativa cafetera guarda **café pergamino seco** en una bodega antes de venderlo.
El sistema vigila tres cosas, cada una con un modelo de IA que corre en el dispositivo:

| Qué se vigila | Sensor | Modelo | Herramienta |
|---|---|---|---|
| Temperatura y humedad | DHT11 | Pronóstico de T y H a 5 min → **alerta anticipada** si la bodega va a salir del rango seguro (15–25 °C, 50–65 %) | TinyML (TensorFlow Lite + EloquentTinyML) |
| Ventiladores de la bodega | MPU6050 (acelerómetro) | Clasificación del estado del ventilador por su vibración: `apagado`, `normal`, `desbalanceado`, `obstruido` | Edge Impulse |
| Calidad del grano | ESP32-CAM | Clasificación de la foto del grano: `sano`, `negro` (grano negro), `partido` (grano partido / mordido) | Edge Impulse |

## Arquitectura

![Arquitectura Edge AI + AWS serverless](docs/arquitectura-final.png)

Los **tres modelos de IA corren en los microcontroladores** (Edge AI). La nube solo recibe, guarda,
muestra y alerta, con servicios **serverless de AWS** (reutilizando la Actividad 3):

| Pieza | Servicio | Qué hace |
|---|---|---|
| Bróker | **AWS IoT Core** | MQTT sobre TLS (8883) con certificado X.509 por dispositivo y política de mínimo privilegio |
| Base de datos | **Amazon DynamoDB** (`bodega-lecturas`) | La regla `bodega_guardar_lecturas` guarda cada mensaje de `bodega1/lecturas` (sensores + predicciones) |
| Alarmas | **Regla de IoT + AWS Lambda** (`bodega-alertas`) → **Telegram** | El ESP32 publica en `bodega1/alertas` solo cuando la IA genera una alarma; la Lambda la envía al bot |
| Dashboard | **Amazon S3** + **API Gateway** + **Lambda** (`bodega-api`) | Sitio web estático que consulta DynamoDB y controla el actuador (`bodega1/led`) |
| Lenguaje natural | **Servidor MCP en el ESP32** | Claude / Gemini / VS Code consultan la bodega por `http://<IP>/mcp` (red local) |

| Tema MQTT | Sentido | Contenido |
|---|---|---|
| `bodega1/lecturas` | ESP32 → AWS, cada 10 s | `temperatura`, `humedad`, `estado`, `t_pred`, `h_pred`, `estado_futuro`, `alerta_anticipada`, `vent_clase`, `vent_confianza`, `vent_falla`, `rms_acc`, `rms_giro`, `led` |
| `bodega1/alertas` | ESP32 → AWS, solo al aparecer | `{"tipo": "alerta_anticipada" / "alerta_th" / "falla_ventilador", "mensaje": "..."}` |
| `bodega1/led` | AWS → ESP32 | `ON` / `OFF` (actuador de ventilación, LED D2) |
| `bodega1/camara` | ESP32-CAM → AWS | Clasificación del grano (en desarrollo) |

Archivos de AWS en [`aws/`](aws/): política del dispositivo, SQL de las reglas y la Lambda de alarmas.

> También existe una **alternativa local con Docker** (Mosquitto, InfluxDB, Grafana, API de alarmas y
> dashboard 3D) en [`backend/`](backend/) y [`dashboard/`](dashboard/); ver la sección
> [Alternativa local con Docker](#alternativa-local-con-docker). Usa su propio contrato de temas
> ([`docs/contrato-mqtt.md`](docs/contrato-mqtt.md)).

## Sketch final del ESP32

[`esp32/bodega_final`](esp32/bodega_final/bodega_final.ino) corre los dos modelos y se conecta a AWS:

- **Modelo T/H (TinyML):** la red 8-16-16-2 del notebook se ejecuta con sus pesos extraídos a
  `modelo_th_pesos.h`. No se usa EloquentTinyML porque su TensorFlow Lite Micro choca
  ("multiple definition") con el que trae la librería de Edge Impulse.
- **Modelo del ventilador (Edge Impulse):** en una tarea de FreeRTOS a 100 Hz exactos, para que la
  conexión no atrase el muestreo.
- **AWS IoT Core:** WiFi + MQTT/TLS con los certificados de `secrets.h` (copiar `secrets.example.h`).
- **Servidor MCP** (JSON-RPC 2.0 sobre HTTP, `POST /mcp`) con las herramientas `leer_sensores`,
  `prediccion_5min`, `estado_ventilador` y `controlar_led`.

Librerías: `bodega-cafe_inferencing` (Edge Impulse), Adafruit MPU6050, DHT sensor library, PubSubClient
y ArduinoJson 7. Paquete de placas **esp32 2.0.17**. La versión sin conexión (solo Monitor serie) está
en [`esp32/bodega_local`](esp32/bodega_local/bodega_local.ino).

### Alarmas por Telegram en AWS

1. Crear el bot con **@BotFather** y obtener el `chat_id` con `https://api.telegram.org/bot<TOKEN>/getUpdates`.
2. *Lambda → Crear función* `bodega-alertas`, Python 3.12, rol **LabRole**, con
   [`lambda_function.py`](aws/lambda/bodega_alertas/lambda_function.py) y las variables de entorno
   `TELEGRAM_TOKEN` y `TELEGRAM_CHAT_ID` (el token nunca va en el código).
3. *IoT Core → Reglas → Crear regla* `bodega_alertas_telegram`: `SELECT * FROM 'bodega1/alertas'`,
   acción **Lambda** → `bodega-alertas`.
4. Probar en el *Cliente de prueba MQTT* publicando en `bodega1/alertas`:
   `{"tipo":"falla_ventilador","mensaje":"Prueba"}`.

## Modelo 2 — Estado del ventilador (Edge Impulse)

### Captura de datos

- El MPU6050 se pegó a la carcasa del motor de un ventilador doméstico (siempre a la misma potencia).
- Sketch [`esp32/captura_ventilador`](esp32/captura_ventilador/captura_ventilador.ino): lee el
  acelerómetro a **100 Hz** e imprime `ax,ay,az`. El programa `edge-impulse-data-forwarder`
  envía esas lecturas al proyecto de Edge Impulse.
- **4 clases × 12 muestras de 10 s = 8 min** de datos. División: 40 muestras de entrenamiento y 8 de prueba.

| Clase | Cómo se simuló |
|---|---|
| `apagado` | Ventilador quieto |
| `normal` | Ventilador encendido sin alteraciones |
| `desbalanceado` | Moneda pegada con cinta en una de las aspas |
| `obstruido` | Cartón tapando parte de la rejilla |

### Impulso

| Bloque | Configuración |
|---|---|
| Datos | Ventana de 2000 ms, desplazamiento de 500 ms, 100 Hz, ejes ax/ay/az |
| Procesamiento | Spectral Analysis (39 características) |
| Aprendizaje | Clasificador: red densa 20 → 10 → 4 clases, 50 ciclos, tasa de aprendizaje 0,0005 |
| Dispositivo objetivo | Espressif ESP-EYE (ESP32 240 MHz) |

![Feature explorer](docs/ei_feature_explorer.png)

### Resultados

| Conjunto | Accuracy | Observaciones |
|---|---|---|
| Validación | **85,3 %** (AUC 0,98, F1 0,85) | `apagado` 100 %, `desbalanceado` 88 %, `normal` 83 %, `obstruido` 75 % |
| Prueba (muestras nunca vistas) | **79,4 %** (AUC 0,98, F1 0,87) | `apagado` 100 %, `obstruido` 94 %, `desbalanceado` 65 %, `normal` 59 % |

En prueba, la mayor parte del error es **incertidumbre** (ventanas donde ninguna clase supera el 60 %
de confianza), no confusión entre clases: con una moneda la vibración cambia poco frente al
ventilador normal.

En el ESP32: **1 ms** de inferencia, **1,4 KB** de RAM y **15 KB** de flash.

![Entrenamiento](docs/ei_entrenamiento.png)
![Model testing](docs/ei_model_testing.jpg)

### Prueba en el ESP32

Sketch [`esp32/prueba_ventilador`](esp32/prueba_ventilador/prueba_ventilador.ino): llena una ventana
de 2 s, ejecuta el modelo con `run_classifier` e imprime la clase. Si detecta `desbalanceado` u
`obstruido` con confianza ≥ 0,60 enciende el **LED de D18** (falla del ventilador).

Resultado en el ESP32 (Monitor serie) probando las cuatro clases con el ventilador: el modelo
reconoce `apagado` con confianza 1,00 y detecta `desbalanceado` y `obstruido` (hasta 0,99) marcando
`<<< FALLA EN VENTILADOR`. Cada predicción tarda **4 ms** de procesamiento (Spectral Analysis) y
menos de 1 ms de red neuronal. En `normal` la confianza baja a ~0,55 porque se parece a
`obstruido`, igual que en la matriz de confusión.

![Prueba en el ESP32](docs/esp32_prueba_ventilador_serial.png)

## Modelo 3 — Calidad del grano con la ESP32-CAM (Edge Impulse)

### Captura de imágenes

- Cámara **ESP32-CAM AI-Thinker** (sensor OV3660) sobre la base **ESP32-CAM-MB** (USB).
- Sketch [`esp32cam/captura_granos`](esp32cam/captura_granos/captura_granos.ino), basado en el ejemplo
  *CameraWebServer*: se encuadra con el video en el navegador y se toma cada foto con *Get Still* /
  `http://IP/capture`.
- Granos de café sobre fondo blanco, con la cámara fija mirando hacia abajo. Los defectos se simularon
  quemando granos (**grano negro**) y aplastándolos (**grano partido / mordido**).
- **3 clases × 40 fotos = 120 imágenes** ([`esp32cam/fotos`](esp32cam/fotos)), división automática:
  96 de entrenamiento y 24 de prueba. Cada archivo se llama `<clase>.<n>.jpg` para que Edge Impulse
  tome la etiqueta del nombre.

### Impulso

| Bloque | Configuración |
|---|---|
| Datos | Imagen 96 × 96, *Fit shortest axis* |
| Procesamiento | Image (RGB) |
| Aprendizaje | Transfer Learning — MobileNetV2 96x96 0.35, con *data augmentation* |
| Dispositivo objetivo | Espressif ESP-EYE (ESP32 240 MHz) |

### Resultados

| Versión del modelo | Validación | Prueba (24 fotos nunca vistas) |
|---|---|---|
| Cuantizada **int8** | 55 % (clasifica casi todo como `sano`) | — |
| **float32** (la que se despliega) | **95 %** | **95,8 %** (AUC 1,00, F1 0,96): `negro` 100 %, `sano` 100 %, `partido` 87,5 % |

En la ESP32-CAM (float32): **4,5 s** por inferencia, **421 KB** de RAM (necesita la PSRAM) y
**1,6 MB** de flash (partición *Huge APP*). Una clasificación cada ~5 s es suficiente para
inspeccionar lotes de grano.

![Prueba float32](docs/cam_model_testing_float32.png)
![Entrenamiento float32](docs/cam_entrenamiento_float32.png)
![Entrenamiento int8](docs/cam_entrenamiento_int8.png)

## Conexiones

| Componente | Pin del ESP32 |
|---|---|
| DHT11 (datos) | D4 |
| MPU6050 SDA / SCL | D21 / D22 |
| LED alerta T/H | D2 |
| LED falla ventilador | D18 |
| VCC / GND de sensores | 3V3 / GND (por los rieles de la protoboard) |

## Alternativa local con Docker

Backend y dashboard alternativos para correr todo en un PC sin AWS.

### Backend

Todo corre con Docker Compose desde [`backend/`](backend/):

| Servicio | Puerto | Qué hace |
|---|---|---|
| Mosquitto | 1883 | Broker MQTT con usuario y clave (ESP32, ESP32-CAM, Telegraf y API) |
| Telegraf | — | Copia cada tema MQTT a InfluxDB (una tabla por tema: `lecturas`, `pronostico`, `imu`, `ventilador`, `vision`, `alertas`) |
| InfluxDB 2 | 8086 | Base de datos de series de tiempo (bucket `bodega`, retención 30 días) |
| API (FastAPI) | 8000 | Valida los mensajes, los reenvía al dashboard por WebSocket, sirve el historial, recibe fotos de la cámara y genera las **alarmas** |
| Dashboard | 8080 | El dashboard compilado, servido por nginx |
| Grafana | 3000 | Tablero `bodega-ia` aprovisionado automáticamente (datasource + paneles) |

```bash
cd backend
cp .env.example .env          # cambiar TODAS las claves y poner el bot de Telegram
docker compose up -d --build
```

Sin hardware se puede probar todo con el simulador, que publica los mismos temas que el ESP32 y la
ESP32-CAM siguiendo un guion de 3 minutos que pasa por todas las alarmas:

```bash
pip install paho-mqtt
python backend/simulador/simular_bodega.py --velocidad 2
```

#### Alarmas a partir de los modelos de IA

El motor de alarmas ([`backend/api/app/alarmas.py`](backend/api/app/alarmas.py)) usa histéresis para no
llenar Telegram de avisos repetidos. Cada alarma activada o resuelta se envía por **Telegram**, se publica
en `bodega1/alertas` (Telegraf la guarda en InfluxDB) y aparece en el dashboard.

| Regla | Se activa | Nivel |
|---|---|---|
| Pronóstico TinyML | el modelo pronostica T o H fuera de rango a 5 min (**alerta anticipada**) | aviso / crítica si se aleja ≥ 4 unidades |
| Ambiente | la lectura actual del DHT11 sale del rango 15–25 °C, 50–65 % | crítica |
| Ventilador | `desbalanceado` u `obstruido` con confianza ≥ 0,60 en 3 ventanas seguidas (6 s) | crítica |
| Cámara | clase de `VISION_CLASES_ALERTA` con confianza ≥ 0,70 (la foto va adjunta en Telegram) | aviso |
| Sin datos | el ESP32 no publica en 60 s | aviso |

Para Telegram: crear el bot con **@BotFather**, escribirle un mensaje y poner `TELEGRAM_TOKEN` y
`TELEGRAM_CHAT_ID` en `backend/.env`. Las reglas tienen pruebas: `cd backend/api && python -m pytest`.

### Dashboard

React + Vite + TypeScript, Tailwind CSS 4, ECharts (canvas, para datos en tiempo real),
react-three-fiber (gemelo digital 3D), Motion y Lucide. Tipografía Geist / Geist Mono.

Tiene **dos vistas** (selector arriba a la derecha, se recuerda en el navegador):

- **Gemelo 3D**: la bodega en 3D se mueve con los datos. El ventilador gira, tiembla o se frena según
  la clase de Edge Impulse; la niebla se vuelve más densa con la humedad; los sacos se oscurecen con riesgo
  de moho; el cono de la ESP32-CAM cambia de color con la clasificación.
- **Analítica**: sin 3D, con el estado de cada modelo y su confianza en anillos, y la gráfica de clima.

Las dos comparten las secciones de **Modelos de IA** (confianza en el tiempo con umbrales, probabilidades
apiladas del ventilador, error del pronóstico TinyML frente a la lectura real y distribución de clases),
ventilador (acelerómetro, giroscopio y línea de tiempo de ventanas), cámara y alarmas.

![Vista 3D](docs/dashboard_vista_3d.jpg)
![Vista analítica](docs/dashboard_vista_analitica.jpg)
![Modelos de IA](docs/dashboard_modelos.jpg)
![Grafana](docs/grafana.jpg)

Desarrollo local (con la API corriendo en el puerto 8000):

```bash
cd dashboard
npm install
npm run dev        # http://localhost:5173
```

Parámetros de la URL: `?demo` (demostración sin backend), `?vel=3` (acelera la demo),
`?vista=3d|analitica`, `?api=http://IP:8000` y `?grafana=URL`. Si la API no responde, el dashboard pasa
solo a la demostración y lo indica en el encabezado («Demostración»).

## Estructura del repositorio

```
esp32/
  captura_ventilador/   Captura del acelerómetro para Edge Impulse
  prueba_ventilador/    Prueba del modelo del ventilador en el ESP32
  bodega_final/         Sketch final: 2 modelos + AWS IoT Core + servidor MCP (secrets.example.h)
  bodega_local/         Versión sin conexión del sketch integrado (solo Monitor serie)
esp32cam/
  captura_granos/       Captura de fotos con la ESP32-CAM (CameraWebServer)
  fotos/                Dataset: 40 fotos por clase (sano, negro, partido)
aws/
  iot/                  Política del dispositivo y SQL de las reglas de IoT
  lambda/bodega_alertas Lambda que envía las alarmas a Telegram
edge-impulse/           Notas del proyecto de Edge Impulse
tinyml/                 Modelo de temperatura y humedad (notebook + .h)
backend/
  docker-compose.yml    Mosquitto, Telegraf, InfluxDB, API, dashboard y Grafana
  api/                  API FastAPI: tiempo real, historial, cámara y alarmas (con pruebas)
  telegraf/ mosquitto/  Configuración del broker y de la ingesta
  grafana/              Datasource y tablero aprovisionados
  simulador/            Simulador del ESP32 y la ESP32-CAM
dashboard/              Dashboard React (vista 3D y vista analítica)
docs/                   Contrato MQTT, diagramas y capturas
```

## Inconvenientes y soluciones

| Inconveniente | Solución |
|---|---|
| `npm install -g edge-impulse-cli` falló: no encontraba Visual Studio para compilar `@serialport/bindings` | Instalar *Build Tools for Visual Studio* con "Desarrollo para el escritorio con C++" |
| npm 11 no ejecutó los scripts de instalación (`allow-scripts`) y el forwarder no podía leer el puerto | `npm install -g edge-impulse-cli --force --allow-scripts=serialport,sharp,@serialport/bindings` |
| El forwarder no conectaba | Cerrar el Monitor serie del Arduino IDE (el puerto COM solo lo usa un programa a la vez) |
| El MPU6050 (GY-521) venía con los pines sin soldar | Prueba provisional: pines en la protoboard y el módulo inclinado y sujeto con cinta |
| `tflm_esp32` 1.0.0 no compilaba con el paquete de placas ESP32 3.x | Usar el paquete de placas **esp32 de Espressif 2.0.17** |
| Las primeras fotos de la ESP32-CAM salían borrosas y con el fondo texturizado (toalla de papel) | Subir la cámara a mayor distancia y usar una hoja blanca lisa como fondo |
| Edge Impulse no dejaba elegir la etiqueta al subir las fotos: quedaron sin etiqueta o con el nombre del archivo | Renombrar los archivos como `<clase>.<n>.jpg` (Edge Impulse toma la etiqueta de lo que va antes del primer punto) y corregir con *Edit labels* |
| El proyecto de la cámara se creó como *Object detection* y no aparecía el bloque de clasificación | *Dashboard → Labeling method → One label per data item* |
| El modelo de imágenes cuantizado (int8) bajó a 55 % de accuracy | Desplegar la versión **float32** (95,8 % en prueba); la ESP32-CAM tiene PSRAM suficiente |
| Al juntar los dos modelos en un solo sketch, EloquentTinyML/`tflm_esp32` y la librería de Edge Impulse daban "multiple definition" al enlazar (las dos traen TensorFlow Lite Micro) | La red T/H se ejecuta con sus pesos extraídos a `modelo_th_pesos.h` (mismas salidas que el intérprete de TFLite) |
| Tailwind CSS 4.0.0 fallaba al compilar los estilos (`Cannot convert undefined or null to object`) | Actualizar a Tailwind 4.1.11 |
| El archivo de claves de Mosquitto no se puede subir a GitHub y escrito desde Windows queda con saltos de línea CRLF | Generarlo en el arranque del contenedor con `mosquitto_passwd` a partir del `.env` |
| La API recibe sus propias alarmas al estar suscrita a `bodega1/#` | El contrato ignora `bodega1/alertas` al validar mensajes |

## Equipo

Proyecto en grupo — Especialización en IA.
