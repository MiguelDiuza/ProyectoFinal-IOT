/*
  Bodega de café pergamino - Sketch final (Edge AI + AWS IoT Core + servidor MCP)
  -------------------------------------------------------------------------------
  Corre los dos modelos de IA en el ESP32 y envía todo a AWS:

   1. Modelo T/H (TinyML, notebook TinyML_bodega_cafe.ipynb):
      DHT11 cada 10 s -> buffer de 25 lecturas (4 min) -> red 8-16-16-2
      -> pronóstico de T y H a 5 min -> alerta anticipada (LED D2).
   2. Modelo del ventilador (Edge Impulse):
      MPU6050 a 100 Hz -> ventana de 2 s -> Spectral Analysis + red
      -> apagado / normal / desbalanceado / obstruido (LED D18 si hay falla).
   3. Conexión (Actividad 3): WiFi + MQTT sobre TLS (puerto 8883) a AWS IoT Core
      con los certificados de secrets.h.
        - bodega1/lecturas : cada 10 s, sensores + predicciones de los dos modelos
                             (la regla de IoT lo guarda en DynamoDB)
        - bodega1/alertas  : solo cuando aparece una alarma generada por la IA
                             (la regla de alarmas la envía a Telegram)
        - bodega1/led      : comando ON/OFF desde el dashboard (actuador, LED D19)
   4. Servidor MCP (Model Context Protocol) en http://<IP>/mcp :
      permite preguntarle a la bodega en lenguaje natural desde Claude, Gemini o
      VS Code. Herramientas: leer_sensores, prediccion_5min, estado_ventilador,
      controlar_led.

  Por qué la red T/H no usa EloquentTinyML/tflm_esp32 (decisión de Juliana):
   La librería de Edge Impulse trae su propia copia de TensorFlow Lite Micro.
   Si además se incluye tflm_esp32 el enlazado falla ("multiple definition").
   La red T/H es pequeña (450 parámetros, solo capas densas), así que se ejecuta
   con los mismos pesos de modelo_bodega.tflite extraídos a modelo_th_pesos.h
   (se verificó que da las mismas salidas que el intérprete de TFLite).

  Organización:
   - tareaVentilador (FreeRTOS, núcleo 1, prioridad 2): muestrea el MPU6050 a
     100 Hz exactos y clasifica cada ventana. Nada del loop la atrasa.
   - loop(): mantiene WiFi/MQTT, atiende el servidor MCP y cada 10 s lee el
     DHT11, corre el modelo T/H, maneja los LEDs y publica en AWS.

  Librerías:
   - bodega-cafe_inferencing (Edge Impulse -> Deployment -> Arduino library)
   - Adafruit MPU6050 (+ Adafruit BusIO, Adafruit Unified Sensor)
   - DHT sensor library (Adafruit)
   - PubSubClient (Nick O'Leary)
   - ArduinoJson (Benoit Blanchon, versión 7)
  NO incluir EloquentTinyML ni tflm_esp32 en este sketch.

  Archivos de la carpeta: bodega_final.ino, modelo_bodega.h, modelo_th_pesos.h y
  secrets.h (WiFi + certificados; NO se sube a GitHub, ver secrets.example.h).

  Conexiones: DHT11 -> D4 | MPU6050 SDA/SCL -> D21/D22 | LED T/H -> D2 | LED ventilador -> D18
              | LED actuador (ventilación, se controla desde el dashboard o por MCP) -> D19
*/

#include <bodega-cafe_inferencing.h>   // modelo del ventilador (Edge Impulse)
#include <Adafruit_MPU6050.h>
#include <Wire.h>
#include <DHT.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>          // conexión cifrada (TLS) con certificados
#include <PubSubClient.h>              // cliente MQTT
#include <WebServer.h>                 // servidor HTTP para MCP
#include <ArduinoJson.h>
#include "modelo_bodega.h"             // normalización + ventanas de prueba del modelo T/H
#include "modelo_th_pesos.h"           // pesos de la red T/H
#include "secrets.h"                   // WIFI_SSID, WIFI_PASS, AWS_ENDPOINT, THING_NAME, certificados

// ===== Pines =====
#define DHTPIN          4
#define DHTTYPE         DHT11
#define LED_TH          2              // alerta anticipada de T/H (solo el modelo TinyML)
#define LED_VENT        18             // falla del ventilador (solo el modelo de Edge Impulse)
#define LED_ACTUADOR    19             // actuador de ventilación: lo enciende una persona (dashboard o MCP)

// ===== Regla de la bodega =====
#define T_MIN 15.0
#define T_MAX 25.0
#define H_MIN 50.0
#define H_MAX 65.0

#define UMBRAL_FALLA        0.60       // confianza mínima para dar falla del ventilador
#define ESPERA_ALERTA_MS    60000UL    // no repetir la misma alarma antes de 1 min

// ===== Temas MQTT =====
const char* TOPIC_LECTURAS = "bodega1/lecturas";   // ESP32 -> AWS (sensores + predicciones)
const char* TOPIC_ALERTAS  = "bodega1/alertas";    // ESP32 -> AWS (alarmas de la IA)
const char* TOPIC_LED      = "bodega1/led";        // AWS -> ESP32 (comando ON/OFF)

DHT dht(DHTPIN, DHTTYPE);
Adafruit_MPU6050 mpu;
WiFiClientSecure net;                  // "tubería" cifrada hacia AWS
PubSubClient mqtt(net);                // MQTT viaja por esa tubería
WebServer server(80);                  // servidor MCP

// ===== Resultado del ventilador (lo escribe la tarea, lo lee el loop) =====
struct EstadoVentilador {
  char  clase[16];
  float confianza;
  bool  falla;
  float rmsAcc;                        // RMS de la aceleración (sin gravedad) en la ventana, m/s²
  float rmsGiro;                       // RMS de la velocidad angular en la ventana, rad/s
  int   msDsp, msRed;
  unsigned long n;                     // número de ventanas clasificadas
};
EstadoVentilador estVent = { "sin datos", 0, false, 0, 0, 0, 0, 0 };
portMUX_TYPE muxVent = portMUX_INITIALIZER_UNLOCKED;

// ===== Estado del modelo T/H =====
float bufT[HIST_LECTURAS], bufH[HIST_LECTURAS];
int   posBuf = 0, nLecturas = 0;
unsigned long ultimaLectura = 0;

// ===== Último resultado completo (lo consulta el servidor MCP) =====
struct Ultimo {
  bool  hayLectura = false;
  float t = 0, h = 0;
  const char* estado = "-";
  bool  hayPred = false;
  float tPred = 0, hPred = 0;
  const char* estFut = "-";
  bool  anticipada = false;
} ult;

bool ledManual = false;                // actuador (D19) encendido desde el dashboard o desde MCP
bool alertaTHAntes = false, fallaVentAntes = false;
unsigned long ultAlertaTH = 0, ultAlertaVent = 0, ultIntentoAWS = 0, ultIntentoWiFi = 0;

const char* estadoTH(float t, float h) {
  return (t >= T_MIN && t <= T_MAX && h >= H_MIN && h <= H_MAX) ? "OK" : "ALERTA";
}
float r2(float x) { return roundf(x * 100) / 100.0f; }   // 2 decimales para el JSON

EstadoVentilador copiaVentilador() {
  EstadoVentilador v;
  portENTER_CRITICAL(&muxVent);
  v = estVent;
  portEXIT_CRITICAL(&muxVent);
  return v;
}

// ------------------------------------------------------------------
//  Modelo T/H: red 8 -> 16 (ReLU) -> 16 (ReLU) -> 2   (código de Juliana)
// ------------------------------------------------------------------
static void densa(const float* x, int nIn, const float* W, const float* b, int nOut, float* y, bool relu) {
  for (int o = 0; o < nOut; o++) {
    float s = b[o];
    for (int i = 0; i < nIn; i++) s += W[o * nIn + i] * x[i];
    y[o] = (relu && s < 0) ? 0 : s;
  }
}

// Mismas entradas que el notebook: [T(t-1)-T(t) ... T(t-4)-T(t), lo mismo para H], normalizadas
void predecirTH(const float T[], const float H[], float &tPred, float &hPred) {
  const int ult = N_PUNTOS - 1, nLags = N_PUNTOS - 1;
  float x[N_ENTRADAS], a1[16], a2[16], y[N_SALIDAS];

  for (int k = 1; k <= nLags; k++) {
    x[k - 1]         = T[ult - k] - T[ult];
    x[nLags + k - 1] = H[ult - k] - H[ult];
  }
  for (int i = 0; i < N_ENTRADAS; i++) x[i] = (x[i] - X_MEAN[i]) / X_STD[i];

  densa(x,  N_ENTRADAS, &TH_W1[0][0], TH_B1, 16, a1, true);
  densa(a1, 16,         &TH_W2[0][0], TH_B2, 16, a2, true);
  densa(a2, 16,         &TH_W3[0][0], TH_B3, N_SALIDAS, y, false);

  // La red predice el cambio normalizado -> se desnormaliza y se suma al valor actual
  tPred = T[ult] + (y[0] * Y_STD[0] + Y_MEAN[0]);
  hPred = H[ult] + (y[1] * Y_STD[1] + Y_MEAN[1]);
}

void validarTH() {
  Serial.println("\n=== Modelo T/H: validación con ventanas reales de prueba ===");
  float errT = 0, errH = 0;
  for (int i = 0; i < DEMO_N; i++) {
    float tP, hP;
    unsigned long t0 = micros();
    predecirTH(DEMO_T[i], DEMO_H[i], tP, hP);
    unsigned long us = micros() - t0;
    errT += fabs(tP - DEMO_REAL_T[i]);
    errH += fabs(hP - DEMO_REAL_H[i]);
    Serial.printf("[%d] Predicho T=%.2f H=%.2f (%s) | Real T=%.1f H=%.1f (%s) | %lu us\n",
                  i, tP, hP, estadoTH(tP, hP), DEMO_REAL_T[i], DEMO_REAL_H[i],
                  estadoTH(DEMO_REAL_T[i], DEMO_REAL_H[i]), us);
  }
  Serial.printf("MAE -> T: %.3f °C | H: %.3f %%\n", errT / DEMO_N, errH / DEMO_N);
}

// ------------------------------------------------------------------
//  Tarea del ventilador: 100 Hz exactos + clasificación con Edge Impulse  (código de Juliana)
// ------------------------------------------------------------------
static float ventana[EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE];   // 200 lecturas x 3 ejes

void tareaVentilador(void*) {
  const TickType_t periodo = pdMS_TO_TICKS((uint32_t)EI_CLASSIFIER_INTERVAL_MS);   // 10 ms
  TickType_t siguiente = xTaskGetTickCount();

  for (;;) {
    // 1. Llenar la ventana de 2 s
    double sumAcc = 0, sumGiro = 0, mx = 0, my = 0, mz = 0;
    for (size_t i = 0; i < EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE; i += 3) {
      vTaskDelayUntil(&siguiente, periodo);
      sensors_event_t a, g, temp;
      mpu.getEvent(&a, &g, &temp);
      ventana[i]     = a.acceleration.x;
      ventana[i + 1] = a.acceleration.y;
      ventana[i + 2] = a.acceleration.z;
      mx += a.acceleration.x; my += a.acceleration.y; mz += a.acceleration.z;
      sumGiro += g.gyro.x * g.gyro.x + g.gyro.y * g.gyro.y + g.gyro.z * g.gyro.z;
    }

    // RMS de vibración (se le quita la media = gravedad) y del giroscopio, para el dashboard
    const int n = EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE / 3;
    mx /= n; my /= n; mz /= n;
    for (int i = 0; i < EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE; i += 3) {
      float dx = ventana[i] - mx, dy = ventana[i + 1] - my, dz = ventana[i + 2] - mz;
      sumAcc += dx * dx + dy * dy + dz * dz;
    }

    // 2. Clasificar
    signal_t senal;
    numpy::signal_from_buffer(ventana, EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE, &senal);
    ei_impulse_result_t r = { 0 };
    if (run_classifier(&senal, &r, false) != EI_IMPULSE_OK) continue;

    int mejor = 0;
    for (int c = 1; c < EI_CLASSIFIER_LABEL_COUNT; c++)
      if (r.classification[c].value > r.classification[mejor].value) mejor = c;
    const char* clase = r.classification[mejor].label;
    float conf = r.classification[mejor].value;
    bool falla = (strcmp(clase, "desbalanceado") == 0 || strcmp(clase, "obstruido") == 0) && conf >= UMBRAL_FALLA;

    digitalWrite(LED_VENT, falla ? HIGH : LOW);

    // 3. Publicar el resultado para el loop
    portENTER_CRITICAL(&muxVent);
    strncpy(estVent.clase, clase, sizeof(estVent.clase) - 1);
    estVent.confianza = conf;
    estVent.falla     = falla;
    estVent.rmsAcc    = sqrt(sumAcc / n);
    estVent.rmsGiro   = sqrt(sumGiro / n);
    estVent.msDsp     = r.timing.dsp;
    estVent.msRed     = r.timing.classification;
    estVent.n++;
    portEXIT_CRITICAL(&muxVent);

    if ((long)(xTaskGetTickCount() - siguiente) > (long)periodo) siguiente = xTaskGetTickCount();
  }
}

// ------------------------------------------------------------------
//  Conexión a AWS IoT Core (Actividad 3)
// ------------------------------------------------------------------
void actualizarLeds() {
  // D2: solo la predicción del modelo T/H | D19: solo el actuador manual (dashboard / MCP)
  bool alertaFutura = ult.hayPred && strcmp(ult.estFut, "ALERTA") == 0;
  digitalWrite(LED_TH, alertaFutura ? HIGH : LOW);
  digitalWrite(LED_ACTUADOR, ledManual ? HIGH : LOW);
}

// Llega un comando del dashboard por bodega1/led
void alRecibir(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  msg.trim(); msg.toUpperCase();
  Serial.printf("Comando recibido [%s]: %s\n", topic, msg.c_str());
  if (msg == "ON")  ledManual = true;
  if (msg == "OFF") ledManual = false;
  actualizarLeds();
}

// Reconecta WiFi y MQTT sin bloquear el resto del programa
void mantenerConexiones() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - ultIntentoWiFi > 10000) {
      ultIntentoWiFi = millis();
      Serial.println("WiFi caído, reconectando...");
      WiFi.reconnect();
    }
    return;
  }
  if (!mqtt.connected() && millis() - ultIntentoAWS > 5000) {
    ultIntentoAWS = millis();
    Serial.print("Conectando a AWS IoT Core... ");
    if (mqtt.connect(THING_NAME)) {               // el nombre debe ser bodega-esp32 (política)
      Serial.println("OK");
      mqtt.subscribe(TOPIC_LED);
    } else {
      Serial.printf("fallo (estado %d), reintento en 5 s\n", mqtt.state());
    }
  }
  mqtt.loop();
}

// Alarma generada por la IA -> bodega1/alertas (la regla de IoT la manda a Telegram)
void publicarAlerta(const char* tipo, const String& mensaje) {
  JsonDocument d;
  d["dispositivo"] = THING_NAME;
  d["tipo"]        = tipo;
  d["mensaje"]     = mensaje;
  String json;
  serializeJson(d, json);
  bool ok = mqtt.connected() && mqtt.publish(TOPIC_ALERTAS, json.c_str());
  Serial.printf(">>> ALERTA %s -> %s\n", json.c_str(), ok ? "publicada" : "NO publicada (sin conexión)");
}

// Lectura completa -> bodega1/lecturas (la regla de IoT la guarda en DynamoDB)
void publicarLectura(const EstadoVentilador& v) {
  JsonDocument d;
  d["dispositivo"] = THING_NAME;
  d["temperatura"] = r2(ult.t);
  d["humedad"]     = r2(ult.h);
  d["estado"]      = ult.estado;
  d["led"]         = ledManual ? "ON" : "OFF";          // actuador D19 (dashboard / MCP)
  if (ult.hayPred) {                               // modelo T/H (TinyML)
    d["t_pred"]            = r2(ult.tPred);
    d["h_pred"]            = r2(ult.hPred);
    d["estado_futuro"]     = ult.estFut;
    d["alerta_anticipada"] = ult.anticipada;
  }
  d["vent_clase"]     = v.clase;                   // modelo del ventilador (Edge Impulse)
  d["vent_confianza"] = r2(v.confianza);
  d["vent_falla"]     = v.falla;
  d["rms_acc"]        = r2(v.rmsAcc);              // acelerómetro
  d["rms_giro"]       = r2(v.rmsGiro);             // giroscopio
  String json;
  serializeJson(d, json);
  bool ok = mqtt.connected() && mqtt.publish(TOPIC_LECTURAS, json.c_str());
  Serial.printf("    AWS %s\n", ok ? "publicado" : "NO publicado (sin conexión)");
}

// ------------------------------------------------------------------
//  Servidor MCP (JSON-RPC 2.0 sobre HTTP, POST /mcp)
// ------------------------------------------------------------------
// Agrega una herramienta a la respuesta de tools/list
void agregarTool(JsonArray tools, const char* nombre, const char* descripcion, bool conEstado = false) {
  JsonObject t = tools.add<JsonObject>();
  t["name"] = nombre;
  t["description"] = descripcion;
  JsonObject schema = t["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  JsonObject props = schema["properties"].to<JsonObject>();
  if (conEstado) {
    JsonObject e = props["estado"].to<JsonObject>();
    e["type"] = "string";
    e["description"] = "on para encender, off para apagar";
    JsonArray en = e["enum"].to<JsonArray>();
    en.add("on"); en.add("off");
    schema["required"].to<JsonArray>().add("estado");
  }
}

// Ejecuta una herramienta y devuelve el texto de respuesta
String ejecutarTool(const char* nombre, JsonVariant args, bool& error) {
  error = false;
  char txt[400];
  if (strcmp(nombre, "leer_sensores") == 0) {
    if (!ult.hayLectura) return "Todavía no hay lecturas del DHT11.";
    snprintf(txt, sizeof(txt),
             "Temperatura %.1f °C y humedad %.1f %% -> estado %s (rango seguro: 15-25 °C y 50-65 %%).",
             ult.t, ult.h, ult.estado);
    return txt;
  }
  if (strcmp(nombre, "prediccion_5min") == 0) {
    if (!ult.hayPred) {
      snprintf(txt, sizeof(txt), "El pronóstico aún no está listo: el modelo necesita 4 minutos de lecturas (%d/%d).",
               nLecturas, HIST_LECTURAS);
      return txt;
    }
    snprintf(txt, sizeof(txt),
             "Modelo TinyML: en %d minutos se esperan %.2f °C y %.2f %% de humedad -> estado %s.%s",
             HORIZONTE_MIN, ult.tPred, ult.hPred, ult.estFut,
             ult.anticipada ? " ALERTA ANTICIPADA: la bodega va a salir del rango seguro." : "");
    return txt;
  }
  if (strcmp(nombre, "estado_ventilador") == 0) {
    EstadoVentilador v = copiaVentilador();
    snprintf(txt, sizeof(txt),
             "Modelo Edge Impulse: el ventilador está '%s' (confianza %.0f %%). %s "
             "Vibración RMS %.3f m/s², giro RMS %.3f rad/s. Inferencia: %d ms.",
             v.clase, v.confianza * 100, v.falla ? "HAY FALLA en el ventilador." : "Sin falla.",
             v.rmsAcc, v.rmsGiro, v.msDsp + v.msRed);
    return txt;
  }
  if (strcmp(nombre, "controlar_led") == 0) {
    const char* e = args["estado"] | "";
    if (strcmp(e, "on") != 0 && strcmp(e, "off") != 0) {   // validar antes de actuar sobre el hardware
      error = true;
      return "Parámetro inválido: estado debe ser 'on' u 'off'.";
    }
    ledManual = strcmp(e, "on") == 0;
    actualizarLeds();
    return ledManual ? "Actuador (ventilación, LED D19) encendido." : "Actuador (ventilación, LED D19) apagado.";
  }
  error = true;
  return String("Herramienta desconocida: ") + nombre;
}

void atenderMCP() {
  if (server.method() != HTTP_POST) { server.send(405, "text/plain", "Usa POST"); return; }

  JsonDocument req;
  if (deserializeJson(req, server.arg("plain"))) { server.send(400, "text/plain", "JSON inválido"); return; }
  const char* metodo = req["method"] | "";
  Serial.printf("[MCP] %s\n", metodo);

  // Las notificaciones (sin id) no llevan respuesta
  if (req["id"].isNull()) { server.send(202, "text/plain", ""); return; }

  JsonDocument res;
  res["jsonrpc"] = "2.0";
  res["id"] = req["id"];

  if (strcmp(metodo, "initialize") == 0) {
    JsonObject r = res["result"].to<JsonObject>();
    r["protocolVersion"] = req["params"]["protocolVersion"] | "2025-03-26";
    r["capabilities"].to<JsonObject>()["tools"].to<JsonObject>();
    JsonObject info = r["serverInfo"].to<JsonObject>();
    info["name"] = "bodega-cafe-esp32";
    info["version"] = "1.0";
  } else if (strcmp(metodo, "tools/list") == 0) {
    JsonArray tools = res["result"].to<JsonObject>()["tools"].to<JsonArray>();
    agregarTool(tools, "leer_sensores",
                "Temperatura y humedad actuales de la bodega de café y si están en el rango seguro.");
    agregarTool(tools, "prediccion_5min",
                "Pronóstico de temperatura y humedad a 5 minutos del modelo TinyML y alerta anticipada.");
    agregarTool(tools, "estado_ventilador",
                "Estado del ventilador según el modelo de vibración (apagado, normal, desbalanceado u obstruido).");
    agregarTool(tools, "controlar_led",
                "Enciende o apaga el actuador de ventilación de la bodega (LED D19).", true);
  } else if (strcmp(metodo, "tools/call") == 0) {
    bool error;
    String texto = ejecutarTool(req["params"]["name"] | "", req["params"]["arguments"], error);
    JsonObject r = res["result"].to<JsonObject>();
    JsonObject c = r["content"].to<JsonArray>().add<JsonObject>();
    c["type"] = "text";
    c["text"] = texto;
    r["isError"] = error;
  } else if (strcmp(metodo, "ping") == 0) {
    res["result"].to<JsonObject>();
  } else {
    JsonObject e = res["error"].to<JsonObject>();
    e["code"] = -32601;
    e["message"] = "Método no soportado";
  }

  String out;
  serializeJson(res, out);
  server.send(200, "application/json; charset=utf-8", out);
}

// ------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("Bodega de café - modelo T/H + modelo del ventilador + AWS + MCP");

  pinMode(LED_TH, OUTPUT);
  pinMode(LED_VENT, OUTPUT);
  pinMode(LED_ACTUADOR, OUTPUT);

  // MPU6050: mismo montaje y configuración que en la captura para Edge Impulse
  Wire.begin(21, 22);
  Wire.setClock(400000);
  if (!mpu.begin()) {
    while (1) { Serial.println("MPU6050 no encontrado"); delay(1000); }
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);

  dht.begin();

  validarTH();
  Serial.printf("Ventilador: ventana %d ms a %.0f Hz, %d clases\n",
                EI_CLASSIFIER_RAW_SAMPLE_COUNT * (int)EI_CLASSIFIER_INTERVAL_MS,
                1000.0 / EI_CLASSIFIER_INTERVAL_MS, EI_CLASSIFIER_LABEL_COUNT);

  // Tarea del ventilador en el núcleo 1, prioridad mayor que el loop (1). WiFi corre en el núcleo 0.
  xTaskCreatePinnedToCore(tareaVentilador, "ventilador", 8192, NULL, 2, NULL, 1);

  // WiFi (espera hasta 20 s; si no conecta, sigue funcionando sin red y reintenta en el loop)
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Conectando WiFi");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " OK" : " sin conexión (se reintenta)");

  // TLS mutuo: el ESP32 verifica a AWS y AWS verifica al ESP32
  net.setCACert(AWS_CERT_CA);
  net.setCertificate(AWS_CERT_CRT);
  net.setPrivateKey(AWS_CERT_PRIVATE);
  mqtt.setServer(AWS_ENDPOINT, 8883);   // 8883 = MQTT sobre TLS
  mqtt.setCallback(alRecibir);
  mqtt.setBufferSize(1024);             // el JSON con las predicciones pasa de 512 bytes
  mqtt.setKeepAlive(60);

  // Servidor MCP
  server.on("/mcp", atenderMCP);
  server.begin();
  Serial.printf("Servidor MCP: http://%s/mcp\n", WiFi.localIP().toString().c_str());
  Serial.printf("DHT11 cada %d s; el primer pronóstico sale a los ~%d min\n\n",
                PERIODO_MS / 1000, (HIST_LECTURAS - 1) * PERIODO_MS / 60000);

  ultimaLectura = millis() - PERIODO_MS;   // primera lectura del DHT de inmediato
}

void loop() {
  mantenerConexiones();                    // WiFi + MQTT (y comandos del dashboard)
  server.handleClient();                   // peticiones MCP

  if (millis() - ultimaLectura < PERIODO_MS) { delay(2); return; }
  ultimaLectura += PERIODO_MS;             // ritmo fijo de 10 s, como en el entrenamiento

  EstadoVentilador v = copiaVentilador();  // último resultado del ventilador

  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("Error DHT11");
    return;
  }

  bufT[posBuf] = t;
  bufH[posBuf] = h;
  posBuf = (posBuf + 1) % HIST_LECTURAS;
  if (nLecturas < HIST_LECTURAS) nLecturas++;

  ult.hayLectura = true;
  ult.t = t; ult.h = h; ult.estado = estadoTH(t, h);
  Serial.printf("T=%.1f H=%.1f (%s)", t, h, ult.estado);

  if (nLecturas < HIST_LECTURAS) {
    Serial.printf(" | pronóstico: llenando buffer %d/%d", nLecturas, HIST_LECTURAS);
  } else {
    // Un punto por minuto: t-4min ... t
    float T[N_PUNTOS], H[N_PUNTOS];
    for (int j = 0; j < N_PUNTOS; j++) {
      int atras = (N_PUNTOS - 1 - j) * PASO_LAG;
      int idx = (posBuf - 1 - atras + 2 * HIST_LECTURAS) % HIST_LECTURAS;
      T[j] = bufT[idx];
      H[j] = bufH[idx];
    }
    predecirTH(T, H, ult.tPred, ult.hPred);
    ult.hayPred    = true;
    ult.estFut     = estadoTH(ult.tPred, ult.hPred);
    ult.anticipada = strcmp(ult.estado, "OK") == 0 && strcmp(ult.estFut, "ALERTA") == 0;
    Serial.printf(" | +%d min: T=%.2f H=%.2f (%s)%s", HORIZONTE_MIN, ult.tPred, ult.hPred, ult.estFut,
                  ult.anticipada ? " <<< ALERTA ANTICIPADA" : "");
  }
  actualizarLeds();

  Serial.printf(" || Ventilador: %s %.2f | RMS acc %.3f m/s2 giro %.3f rad/s | DSP %d ms red %d ms%s\n",
                v.clase, v.confianza, v.rmsAcc, v.rmsGiro, v.msDsp, v.msRed,
                v.falla ? " <<< FALLA EN VENTILADOR" : "");

  publicarLectura(v);

  // ===== Alarmas de la IA: solo cuando aparecen (no cada 10 s) =====
  bool alertaTH = ult.hayPred && strcmp(ult.estFut, "ALERTA") == 0;
  if (alertaTH && !alertaTHAntes && millis() - ultAlertaTH > ESPERA_ALERTA_MS) {
    ultAlertaTH = millis();
    char m[160];
    snprintf(m, sizeof(m), "La bodega estará fuera de rango en %d min: T=%.1f °C, H=%.1f %% (ahora T=%.1f, H=%.1f)",
             HORIZONTE_MIN, ult.tPred, ult.hPred, t, h);
    publicarAlerta(ult.anticipada ? "alerta_anticipada" : "alerta_th", m);
  }
  alertaTHAntes = alertaTH;

  if (v.falla && !fallaVentAntes && millis() - ultAlertaVent > ESPERA_ALERTA_MS) {
    ultAlertaVent = millis();
    char m[160];
    snprintf(m, sizeof(m), "Falla en el ventilador: %s (confianza %.0f %%, vibración RMS %.2f m/s²)",
             v.clase, v.confianza * 100, v.rmsAcc);
    publicarAlerta("falla_ventilador", m);
  }
  fallaVentAntes = v.falla;
}
