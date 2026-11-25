/*
  ESP32-CAM - Clasificación de granos de café (Edge Impulse) + AWS IoT Core
  -------------------------------------------------------------------------
  Tercer modelo de IA del proyecto. Corre en la ESP32-CAM, no en la nube:

   1. Cada 10 s toma una foto (320x240), recorta el cuadrado central y lo
      reduce a 96x96, que es el tamaño con el que se entrenó el modelo.
   2. El modelo de Edge Impulse (MobileNetV2 96x96, float32) da la probabilidad
      de cada clase: negro (grano negro) / partido (grano partido o mordido) / sano.
   3. Publica el resultado por MQTT sobre TLS (puerto 8883) en AWS IoT Core:
        - bodega1/camara  : cada clasificación (la regla bodega_guardar_camara
                            la guarda en DynamoDB, tabla bodega-lecturas)
        - bodega1/alertas : solo si encuentra un grano defectuoso con confianza
                            alta (la regla bodega_alertas_telegram -> Lambda -> Telegram)
   4. Vista web en http://<IP> (sale en el Monitor serie): la cámara en vivo
      y la última clasificación, para enfocar y para la demo. Mientras el
      modelo clasifica (~4-5 s) la imagen se queda quieta un momento: es normal.

  Librerías:
   - bodega-cafe-camara_inferencing (Edge Impulse -> Deployment -> Arduino library, float32)
   - PubSubClient (Nick O'Leary) y ArduinoJson 7
  Placa: AI Thinker ESP32-CAM | Partition Scheme: Huge APP (3MB No OTA) | PSRAM activada

  secrets.h (NO se sube a GitHub): WiFi, endpoint de IoT Core y el certificado y
  la llave PROPIOS de la cámara (thing bodega1-camara). Si usara los del ESP32
  principal, los dos tendrían el mismo nombre de cliente y AWS los desconectaría
  entre sí.
*/

#include <bodega-cafe-camara_inferencing.h>       // modelo de granos (Edge Impulse, v1.0.3 float32)
#include "edge-impulse-sdk/dsp/image/image.hpp"   // recorte y redimensión de la imagen
#include "esp_camera.h"                           // controlador de la cámara
#include <WiFi.h>
#include <WiFiClientSecure.h>                     // conexión cifrada (TLS) con certificados
#include <WebServer.h>                            // vista web
#include <PubSubClient.h>                         // cliente MQTT
#include <ArduinoJson.h>                          // arma los mensajes JSON
#include <time.h>                                 // hora real (NTP) para el campo epoch
#include "secrets.h"                              // WIFI_SSID, WIFI_PASSWORD, AWS_IOT_ENDPOINT, THINGNAME, certificados

// Protección: si se instala por error la librería del ventilador, no compila
#if !defined(EI_CLASSIFIER_SENSOR) || EI_CLASSIFIER_SENSOR != EI_CLASSIFIER_SENSOR_CAMERA
#error "Esta librería no es de un modelo de cámara"
#endif

// ===== Pines de la cámara en la placa AI-Thinker (fijos, vienen del fabricante) =====
#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22
#define LED_ROJO        33   // LED rojo de la placa (se enciende con LOW): grano defectuoso
#define LED_FLASH        4   // flash blanco

// ===== Ajustes =====
#define RAW_COLS 320                  // resolución de la foto (QVGA)
#define RAW_ROWS 240
#define INTERVALO_MS     10000        // una clasificación cada 10 s
#define UMBRAL           0.60f        // si la mejor clase no llega al 60 %, el resultado es "incierto"
#define UMBRAL_ALERTA    0.80f        // confianza mínima para mandar alarma a Telegram
#define COOLDOWN_ALERTA  60000        // no repetir la alarma antes de 1 min
#define ENVIAR_ALERTAS   true
#define USAR_FLASH       false        // las fotos de entrenamiento se tomaron sin flash

// ===== Temas MQTT =====
#define TOPIC_CAMARA  "bodega1/camara"    // ESP32-CAM -> AWS (cada clasificación)
#define TOPIC_ALERTAS "bodega1/alertas"   // ESP32-CAM -> AWS (grano defectuoso)

WiFiClientSecure net;                 // "tubería" cifrada hacia AWS
PubSubClient mqtt(net);               // MQTT viaja por esa tubería
static uint8_t *snapshot_buf = nullptr;   // imagen RGB888 (en la PSRAM, porque no cabe en la RAM normal)
unsigned long ultimoCiclo = 0, ultimaAlerta = 0;
WebServer server(80);                 // vista web
String ultimoResultado = "Esperando la primera clasificación...";

// ------------------------------------------------------------------
//  Cámara + modelo
// ------------------------------------------------------------------
bool camara_init() {
  camera_config_t c = {};
  // Pines de datos y control de la cámara
  c.pin_pwdn = PWDN_GPIO_NUM;   c.pin_reset = RESET_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;   c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM; c.pin_d0 = Y2_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM;
  c.xclk_freq_hz = 20000000;                    // reloj de la cámara: 20 MHz
  c.ledc_timer = LEDC_TIMER_0;  c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;              // la cámara entrega JPEG (sirve también para la vista web)
  c.frame_size = FRAMESIZE_QVGA;                // 320x240
  c.jpeg_quality = 12;                          // 0-63: más bajo = mejor calidad
  c.fb_count = 1;                               // un solo búfer de imagen
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  if (esp_camera_init(&c) != ESP_OK) return false;

  sensor_t *s = esp_camera_sensor_get();
  // Mismos ajustes que CameraWebServer, con el que se tomaron las fotos de entrenamiento.
  // Si los colores fueran distintos, el modelo vería imágenes diferentes a las que aprendió.
  if (s->id.PID == OV3660_PID) { s->set_vflip(s, 1); s->set_brightness(s, 1); s->set_saturation(s, -2); }
  return true;
}

// Toma una foto y la deja en "out" como RGB888 de w x h (96x96)
bool capturar(uint32_t w, uint32_t h, uint8_t *out) {
  camera_fb_t *fb = esp_camera_fb_get();          // la primera foto puede ser vieja: se descarta
  if (fb) esp_camera_fb_return(fb);

  if (USAR_FLASH) { digitalWrite(LED_FLASH, HIGH); delay(150); }
  fb = esp_camera_fb_get();                       // foto nueva
  if (USAR_FLASH) digitalWrite(LED_FLASH, LOW);
  if (!fb) return false;

  bool ok = fmt2rgb888(fb->buf, fb->len, PIXFORMAT_JPEG, out);   // JPEG -> píxeles RGB
  esp_camera_fb_return(fb);
  if (!ok) return false;

  // Recorte del cuadrado central + reducción a 96x96 ("Fit shortest axis", igual que en Edge Impulse)
  if (w != RAW_COLS || h != RAW_ROWS)
    ei::image::processing::crop_and_interpolate_rgb888(out, RAW_COLS, RAW_ROWS, out, w, h);
  return true;
}

// Edge Impulse pide cada píxel como un número 0xRRGGBB.
// fmt2rgb888 entrega los colores en orden B,G,R, así que se reordenan aquí.
static int get_data(size_t offset, size_t length, float *out_ptr) {
  size_t px = offset * 3, i = 0;
  while (length--) {
    out_ptr[i++] = (snapshot_buf[px + 2] << 16) + (snapshot_buf[px + 1] << 8) + snapshot_buf[px];
    px += 3;
  }
  return 0;
}

// ------------------------------------------------------------------
//  Conexión a AWS IoT Core
// ------------------------------------------------------------------
void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf(" OK %s\n", WiFi.localIP().toString().c_str());
}

// Un intento de conexión a AWS cada 5 s, SIN bloquear: así la vista web sigue
// funcionando aunque AWS falle.
unsigned long ultimoIntentoAWS = 0;
void conectarAWS() {
  if (mqtt.connected() || (ultimoIntentoAWS && millis() - ultimoIntentoAWS < 5000)) return;
  ultimoIntentoAWS = millis();
  conectarWiFi();
  Serial.print("AWS IoT... ");
  if (mqtt.connect(THINGNAME)) {                // el nombre debe ser bodega1-camara (política)
    Serial.println("conectado");
  } else {
    // rc=-2: AWS rechazó la conexión TLS (certificado inactivo / sin política / endpoint)
    char err[100] = "";
    net.lastError(err, sizeof(err));            // motivo exacto que da la capa TLS
    Serial.printf("falló (rc=%d) %s | reintento en 5 s\n", mqtt.state(), err);
  }
}

// Hora real (segundos desde 1970) tomada por NTP; 0 si todavía no se sincronizó
uint32_t epoch() { time_t t = time(nullptr); return t > 1700000000 ? (uint32_t)t : 0; }

// ------------------------------------------------------------------
//  Vista web (http://<IP>)
// ------------------------------------------------------------------
// Página: foto en vivo + último resultado. El JavaScript pide una foto nueva
// cada ~0,8 s y el resultado cada 2 s.
void webInicio() {
  String html = F("<!DOCTYPE html><html><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>ESP32-CAM granos</title>"
    "<style>body{font-family:sans-serif;background:#111;color:#eee;text-align:center}"
    "img{width:96vw;max-width:640px;border:2px solid #555}"
    "#r{font-size:1.4em;margin:12px}</style></head><body>"
    "<h2>ESP32-CAM - granos de café</h2>"
    "<img id='f' src='/vivo'><div id='r'></div>"
    "<p>El modelo ve el <b>cuadrado central</b> de la imagen (recortado a 96x96).</p>"
    "<script>"
    "function f(){var i=new Image();i.onload=function(){document.getElementById('f').src=i.src;setTimeout(f,800)};"
    "i.onerror=function(){setTimeout(f,1500)};i.src='/vivo?t='+Date.now()}"
    "function r(){fetch('/resultado').then(x=>x.text()).then(t=>document.getElementById('r').innerText=t)"
    ".catch(()=>{});setTimeout(r,2000)}"
    "f();r();</script></body></html>");
  server.send(200, "text/html", html);
}

// /vivo: foto JPEG tomada en ese momento
void webVivo() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);          // descarta el frame viejo
  fb = esp_camera_fb_get();
  if (!fb) { server.send(503, "text/plain", "sin imagen"); return; }
  server.sendHeader("Cache-Control", "no-store");   // que el navegador no reutilice una foto vieja
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  server.sendContent((const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

// /resultado: texto con la última clasificación
void webResultado() { server.send(200, "text/plain; charset=utf-8", ultimoResultado); }

// ------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(LED_ROJO, OUTPUT);  digitalWrite(LED_ROJO, HIGH);   // apagado
  pinMode(LED_FLASH, OUTPUT); digitalWrite(LED_FLASH, LOW);

  // El modelo (421 KB) y la imagen necesitan la PSRAM de 4 MB de la placa
  if (!psramFound())  { Serial.println("ERR: activa PSRAM"); while (1) delay(1000); }
  if (!camara_init()) { Serial.println("ERR: cámara");       while (1) delay(1000); }
  snapshot_buf = (uint8_t *)ps_malloc(RAW_COLS * RAW_ROWS * 3);   // 320 x 240 x 3 colores
  if (!snapshot_buf)  { Serial.println("ERR: buffer");       while (1) delay(1000); }

  conectarWiFi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // hora real (UTC) para el campo epoch

  // TLS mutuo: la cámara verifica a AWS y AWS verifica a la cámara
  net.setCACert(AWS_CERT_CA);
  net.setCertificate(AWS_CERT_CRT);
  net.setPrivateKey(AWS_CERT_PRIVATE);
  mqtt.setServer(AWS_IOT_ENDPOINT, 8883);   // 8883 = MQTT sobre TLS
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(60);

  // Vista web
  server.on("/", webInicio);
  server.on("/vivo", webVivo);
  server.on("/resultado", webResultado);
  server.begin();
  Serial.printf(">>> Vista web: http://%s\n", WiFi.localIP().toString().c_str());

  conectarAWS();

  Serial.printf("Heap libre: %u | PSRAM libre: %u\n", ESP.getFreeHeap(), ESP.getFreePsram());
}

void loop() {
  server.handleClient();                     // atiende el navegador
  conectarAWS();                             // reconexión si se cae (sin bloquear)
  mqtt.loop();

  if (millis() - ultimoCiclo < INTERVALO_MS) return;   // clasifica cada 10 s sin bloquear la web
  ultimoCiclo = millis();

  // ===== 1. Foto -> 96x96 =====
  if (!capturar(EI_CLASSIFIER_INPUT_WIDTH, EI_CLASSIFIER_INPUT_HEIGHT, snapshot_buf)) {
    Serial.println("ERR: captura"); return;
  }

  // ===== 2. Clasificar con el modelo de Edge Impulse =====
  ei::signal_t signal;
  signal.total_length = EI_CLASSIFIER_INPUT_WIDTH * EI_CLASSIFIER_INPUT_HEIGHT;   // 96 x 96 píxeles
  signal.get_data = &get_data;
  ei_impulse_result_t r = {0};
  if (run_classifier(&signal, &r, false) != EI_IMPULSE_OK) { Serial.println("ERR: clasificador"); return; }

  // ===== 3. Clase con mayor probabilidad =====
  int mejor = 0;
  for (int i = 1; i < EI_CLASSIFIER_LABEL_COUNT; i++)
    if (r.classification[i].value > r.classification[mejor].value) mejor = i;
  float conf = r.classification[mejor].value;
  const char *clase = conf >= UMBRAL ? r.classification[mejor].label : "incierto";
  bool defecto = strcmp(clase, "negro") == 0 || strcmp(clase, "partido") == 0;
  digitalWrite(LED_ROJO, defecto ? LOW : HIGH);   // LED rojo de la placa = grano defectuoso

  // Texto para la página web
  ultimoResultado = String(clase) + " (" + String(conf * 100, 0) + " %)  |  ";
  for (int i = 0; i < EI_CLASSIFIER_LABEL_COUNT; i++)
    ultimoResultado += String(r.classification[i].label) + " " + String(r.classification[i].value, 2) + "   ";
  ultimoResultado += "|  IA " + String(r.timing.classification) + " ms";

  // ===== 4. Publicar en bodega1/camara (-> DynamoDB) =====
  JsonDocument doc;
  doc["dispositivo"]   = THINGNAME;               // clave de partición en DynamoDB
  doc["epoch"]         = epoch();
  doc["clase"]         = clase;
  doc["confianza"]     = serialized(String(conf, 3));
  for (int i = 0; i < EI_CLASSIFIER_LABEL_COUNT; i++) {
    String k = String("prob_") + r.classification[i].label;   // prob_negro, prob_partido, prob_sano
    doc[k] = serialized(String(r.classification[i].value, 3));
  }
  doc["dsp_ms"]        = r.timing.dsp;            // tiempo de preparar la imagen
  doc["inferencia_ms"] = r.timing.classification; // tiempo de la red neuronal

  char payload[384];
  serializeJson(doc, payload);
  bool ok = mqtt.connected() && mqtt.publish(TOPIC_CAMARA, payload);
  Serial.printf("%s -> %s\n", ok ? "PUB OK" : "PUB FALLÓ", payload);

  // ===== 5. Alarma: grano defectuoso (-> Lambda -> Telegram) =====
  // Solo con confianza alta y como máximo una vez por minuto, para no llenar Telegram
  if (ENVIAR_ALERTAS && defecto && conf >= UMBRAL_ALERTA &&
      (ultimaAlerta == 0 || millis() - ultimaAlerta > COOLDOWN_ALERTA)) {
    JsonDocument a;
    a["dispositivo"] = THINGNAME;
    a["tipo"]        = "grano_defectuoso";        // la Lambda le pone el ícono ☕
    a["clase"]       = clase;
    a["confianza"]   = serialized(String(conf, 2));
    a["mensaje"]     = String("Grano ") + clase + " detectado (" + String(conf * 100, 0) + "%)";
    char buf[256];
    serializeJson(a, buf);
    if (mqtt.connected() && mqtt.publish(TOPIC_ALERTAS, buf)) { ultimaAlerta = millis(); Serial.printf("ALERTA -> %s\n", buf); }
  }
}
