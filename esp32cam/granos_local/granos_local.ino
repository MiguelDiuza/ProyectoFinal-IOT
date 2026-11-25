/*
 * granos_local.ino — Fase 1: inferencia LOCAL en ESP32-CAM AI-Thinker (OV3660)
 * Modelo Edge Impulse: MobileNetV2 96x96 (float32) — clases: negro / partido / sano
 *
 * Arduino IDE:
 *   Placa: "AI Thinker ESP32-CAM"
 *   PSRAM: Enabled
 *   Partition Scheme: "Huge APP (3MB No OTA/1MB SPIFFS)"
 *   Monitor serie: 115200
 */

// >>> CAMBIA este include por el nombre de TU librería exportada de Edge Impulse <<<
#include <bodega-cafe-camara_inferencing.h>   // librería exportada de Edge Impulse (v1.0.2 float32)
#include "edge-impulse-sdk/dsp/image/image.hpp"
#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>

// ---------- WiFi (solo para la vista web; NO subir la clave a GitHub) ----------
#define WIFI_SSID      "TU_WIFI"
#define WIFI_PASSWORD  "TU_CLAVE"

#if !defined(EI_CLASSIFIER_SENSOR) || EI_CLASSIFIER_SENSOR != EI_CLASSIFIER_SENSOR_CAMERA
#error "Esta librería no es de un modelo de cámara"
#endif

// ---------- Pines AI-Thinker ----------
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

#define LED_ROJO        33   // LED rojo de la placa (activo en BAJO)
#define LED_FLASH        4   // flash blanco

// ---------- Ajustes ----------
#define RAW_COLS 320          // QVGA
#define RAW_ROWS 240
#define INTERVALO_MS 3000     // cada cuánto clasificar
#define UMBRAL 0.60f          // por debajo = "incierto"
#define USAR_FLASH false      // true si entrenaste con flash encendido

static uint8_t *snapshot_buf = nullptr;   // RGB888 en PSRAM

WebServer server(80);
String ultimoResultado = "Esperando la primera clasificación...";
unsigned long ultimoCiclo = 0;

// ---------- Cámara ----------
bool camara_init() {
  camera_config_t c = {};
  c.pin_pwdn = PWDN_GPIO_NUM;   c.pin_reset = RESET_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;   c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM; c.pin_d0 = Y2_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.ledc_timer = LEDC_TIMER_0;  c.ledc_channel = LEDC_CHANNEL_0;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_QVGA;
  c.jpeg_quality = 12;
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

  if (esp_camera_init(&c) != ESP_OK) return false;

  sensor_t *s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {        // ajustes típicos del OV3660
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -2);   // igual que CameraWebServer, con el que se tomaron las fotos de entrenamiento
  }
  return true;
}

bool capturar(uint32_t w, uint32_t h, uint8_t *out) {
  // Descarta un frame viejo para tener una foto fresca
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);

  if (USAR_FLASH) { digitalWrite(LED_FLASH, HIGH); delay(150); }
  fb = esp_camera_fb_get();
  if (USAR_FLASH) digitalWrite(LED_FLASH, LOW);
  if (!fb) { Serial.println("ERR: no se pudo capturar"); return false; }

  bool ok = fmt2rgb888(fb->buf, fb->len, PIXFORMAT_JPEG, out);
  esp_camera_fb_return(fb);
  if (!ok) { Serial.println("ERR: conversión JPEG->RGB"); return false; }

  // Recorte central + redimensión a 96x96
  if (w != RAW_COLS || h != RAW_ROWS) {
    ei::image::processing::crop_and_interpolate_rgb888(out, RAW_COLS, RAW_ROWS, out, w, h);
  }
  return true;
}

// Edge Impulse pide cada píxel como float 0xRRGGBB
static int get_data(size_t offset, size_t length, float *out_ptr) {
  size_t px = offset * 3, i = 0;
  while (length--) {
    // fmt2rgb888 entrega BGR -> se invierte a RGB
    out_ptr[i++] = (snapshot_buf[px + 2] << 16) + (snapshot_buf[px + 1] << 8) + snapshot_buf[px];
    px += 3;
  }
  return 0;
}

// ---------- Setup / Loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(LED_ROJO, OUTPUT);  digitalWrite(LED_ROJO, HIGH);  // apagado
  pinMode(LED_FLASH, OUTPUT); digitalWrite(LED_FLASH, LOW);

  if (!psramFound()) { Serial.println("ERR: activa PSRAM en Herramientas"); while (1) delay(1000); }
  if (!camara_init()) { Serial.println("ERR: cámara no inicia"); while (1) delay(1000); }

  snapshot_buf = (uint8_t *)ps_malloc(RAW_COLS * RAW_ROWS * 3);
  if (!snapshot_buf) { Serial.println("ERR: sin memoria para el buffer"); while (1) delay(1000); }

  Serial.printf("Modelo: %d x %d, %d clases\n",
                EI_CLASSIFIER_INPUT_WIDTH, EI_CLASSIFIER_INPUT_HEIGHT, EI_CLASSIFIER_LABEL_COUNT);
  Serial.printf("Heap libre: %u | PSRAM libre: %u\n", ESP.getFreeHeap(), ESP.getFreePsram());

  // WiFi + vista web
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  if (WiFi.status() == WL_CONNECTED) {
    server.on("/", webInicio);
    server.on("/vivo", webVivo);
    server.on("/resultado", webResultado);
    server.begin();
    Serial.printf(" OK\n>>> Abre en el navegador: http://%s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(" sin conexión (solo Monitor serie)");
  }
}

// ---------- Vista web ----------
// Página: foto en vivo + último resultado. JavaScript recarga la foto cada segundo.
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

// Foto en vivo (JPEG) tomada en el momento
void webVivo() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);          // descarta el frame viejo
  fb = esp_camera_fb_get();
  if (!fb) { server.send(503, "text/plain", "sin imagen"); return; }
  server.sendHeader("Cache-Control", "no-store");
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  server.sendContent((const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

void webResultado() { server.send(200, "text/plain; charset=utf-8", ultimoResultado); }

void loop() {
  server.handleClient();                     // atiende el navegador
  if (millis() - ultimoCiclo < INTERVALO_MS) return;
  ultimoCiclo = millis();

  if (!capturar(EI_CLASSIFIER_INPUT_WIDTH, EI_CLASSIFIER_INPUT_HEIGHT, snapshot_buf)) return;

  ei::signal_t signal;
  signal.total_length = EI_CLASSIFIER_INPUT_WIDTH * EI_CLASSIFIER_INPUT_HEIGHT;
  signal.get_data = &get_data;

  ei_impulse_result_t r = {0};
  EI_IMPULSE_ERROR err = run_classifier(&signal, &r, false);
  if (err != EI_IMPULSE_OK) { Serial.printf("ERR run_classifier: %d\n", err); return; }

  // Mejor clase
  int mejor = 0;
  for (int i = 1; i < EI_CLASSIFIER_LABEL_COUNT; i++)
    if (r.classification[i].value > r.classification[mejor].value) mejor = i;

  const char *clase = r.classification[mejor].value >= UMBRAL ? r.classification[mejor].label : "incierto";
  float conf = r.classification[mejor].value;

  Serial.printf("\n[DSP %d ms | IA %d ms]\n", r.timing.dsp, r.timing.classification);
  for (int i = 0; i < EI_CLASSIFIER_LABEL_COUNT; i++)
    Serial.printf("  %-8s %.3f\n", r.classification[i].label, r.classification[i].value);
  Serial.printf("=> %s (%.0f%%)\n", clase, conf * 100);

  // Texto para la página web
  ultimoResultado = String(clase) + " (" + String(conf * 100, 0) + " %)  |  ";
  for (int i = 0; i < EI_CLASSIFIER_LABEL_COUNT; i++)
    ultimoResultado += String(r.classification[i].label) + " " + String(r.classification[i].value, 2) + "   ";
  ultimoResultado += "|  IA " + String(r.timing.classification) + " ms";

  // LED rojo encendido si el grano es defectuoso
  bool defecto = strcmp(clase, "negro") == 0 || strcmp(clase, "partido") == 0;
  digitalWrite(LED_ROJO, defecto ? LOW : HIGH);
}
