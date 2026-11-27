/*
  ==============================================================================
  CAPTURA DE FOTOS DE GRANOS DE CAFÉ — ESP32-CAM (AI-Thinker, sensor OV3660)
  ==============================================================================
  ¿Para qué sirve este sketch?
    Es la etapa de RECOLECCIÓN DE DATOS del Modelo 3 (calidad del grano).
    Convierte la ESP32-CAM en una cámara web: al abrir su IP en el navegador se ve
    el video en vivo y se pueden tomar fotos. Con él se tomaron las 120 fotos de
    granos (sano / negro / partido) que se subieron a Edge Impulse para entrenar.

  ¿Por qué tomar las fotos con la misma ESP32-CAM y no con un celular?
    Para que el modelo aprenda con la misma cámara, resolución, colores y ruido
    que va a tener cuando clasifique en la bodega. Si se entrena con fotos de
    celular, el modelo falla en el dispositivo real.

  Flujo de uso:
    1. Cargar el sketch y abrir el Monitor serie (115200) para ver la IP.
    2. Abrir http://<IP> en el navegador → "Start Stream" para encuadrar el grano.
    3. "Get Still" (o http://<IP>/capture) para tomar la foto y guardarla.
    4. Guardar cada foto en esp32cam/fotos/<clase>/ y subirlas a Edge Impulse.

  Base: ejemplo CameraWebServer del paquete esp32 de Arduino. Cambios propios:
    - Modelo de cámara AI_THINKER (línea 44).
    - Credenciales de la red WiFi (líneas 52-53).
  Archivos que acompañan este sketch (sin cambios, vienen del ejemplo):
    - app_httpd.cpp   : servidor web (rutas /, /stream, /capture, /control).
    - camera_index.h  : página web comprimida con los controles de la cámara.
    - camera_pins.h   : pines de cada modelo de cámara.

  Configuración en el Arduino IDE:
    Placa: AI Thinker ESP32-CAM | Partition Scheme: Huge APP (3MB No OTA) | Puerto: COM4
  ==============================================================================
*/

#include "esp_camera.h"   // librería de la cámara (drivers del sensor OV3660)
#include <WiFi.h>         // conexión a la red WiFi

// ------------------------------------------------------------------------------
// 1. MODELO DE CÁMARA
// ------------------------------------------------------------------------------
// El ejemplo trae una lista de placas; se deja activa solo la AI-Thinker, que es
// la que se usa. camera_pins.h toma esta definición y asigna los pines
// correctos (datos D0-D7, reloj, sincronismo, I2C del sensor, etc.).
#define CAMERA_MODEL_AI_THINKER   // ESP32-CAM AI-Thinker (tiene PSRAM de 4 MB)
#include "camera_pins.h"

// ------------------------------------------------------------------------------
// 2. CREDENCIALES WIFI
// ------------------------------------------------------------------------------
// La ESP32 solo se conecta a redes de 2,4 GHz. En el repositorio se dejan valores
// de ejemplo; la clave real nunca se sube a GitHub.
const char* ssid = "TU_WIFI";          // nombre de la red WiFi (2,4 GHz)
const char* password = "TU_CLAVE";     // clave de la red

// Funciones definidas en app_httpd.cpp (servidor web del ejemplo)
void startCameraServer();      // arranca la página web y las rutas /stream y /capture
void setupLedFlash(int pin);   // configura el LED flash de la placa (GPIO 4)

void setup() {
  // Monitor serie: aquí se ve el avance de la conexión y la IP de la cámara
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  // ----------------------------------------------------------------------------
  // 3. CONFIGURACIÓN DE LA CÁMARA
  // ----------------------------------------------------------------------------
  camera_config_t config;

  // Reloj que la ESP32 le entrega al sensor (canal y temporizador PWM)
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  // Pines del bus de datos paralelo de 8 bits por donde llega la imagen
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  // Pines de control: reloj, sincronismo de píxel/línea/cuadro
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;

  // Bus SCCB (tipo I2C) para enviarle ajustes al sensor (brillo, saturación...)
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;

  // Pines de apagado y reinicio del sensor
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;           // reloj del sensor: 20 MHz
  config.frame_size = FRAMESIZE_UXGA;       // tamaño máximo reservado: 1600x1200
  config.pixel_format = PIXFORMAT_JPEG;     // las fotos salen comprimidas en JPEG
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;  // la imagen se guarda en la PSRAM (4 MB)
  config.jpeg_quality = 12;                 // 0-63: número menor = mejor calidad
  config.fb_count = 1;                      // cantidad de buffers de imagen

  // Con PSRAM (la AI-Thinker la tiene) se sube la calidad y se usan 2 buffers:
  // mientras uno se envía por WiFi, el otro ya captura el siguiente cuadro,
  // y siempre se entrega la imagen más reciente (video más fluido).
  if (config.pixel_format == PIXFORMAT_JPEG) {
    if (psramFound()) {
      config.jpeg_quality = 10;
      config.fb_count = 2;
      config.grab_mode = CAMERA_GRAB_LATEST;
    } else {
      // Sin PSRAM no cabe UXGA: se baja a 800x600 en la RAM interna
      config.frame_size = FRAMESIZE_SVGA;
      config.fb_location = CAMERA_FB_IN_DRAM;
    }
  }

  // ----------------------------------------------------------------------------
  // 4. ENCENDER LA CÁMARA
  // ----------------------------------------------------------------------------
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    // Si falla aquí: placa mal elegida, cámara mal conectada o falta de energía
    Serial.printf("Error al iniciar la cámara: 0x%x", err);
    return;
  }

  // ----------------------------------------------------------------------------
  // 5. AJUSTES DE IMAGEN DEL SENSOR OV3660
  // ----------------------------------------------------------------------------
  // IMPORTANTE para la exposición: estos mismos ajustes se repiten en el sketch
  // de clasificación (camara_bodega.ino). Si la cámara ve los colores distintos a
  // como los vio al tomar las fotos de entrenamiento, el modelo se equivoca.
  sensor_t* s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);        // el sensor viene volteado: se endereza la imagen
    s->set_brightness(s, 1);   // un poco más de brillo
    s->set_saturation(s, -2);  // menos saturación (el OV3660 exagera los colores)
  }

  // Arranca en 320x240 para que el video en vivo sea rápido; desde la página web
  // se puede cambiar la resolución antes de tomar cada foto.
  if (config.pixel_format == PIXFORMAT_JPEG) {
    s->set_framesize(s, FRAMESIZE_QVGA);
  }

  // LED flash de la placa (se controla desde la página web)
#if defined(LED_GPIO_NUM)
  setupLedFlash(LED_GPIO_NUM);
#endif

  // ----------------------------------------------------------------------------
  // 6. CONEXIÓN WIFI
  // ----------------------------------------------------------------------------
  WiFi.begin(ssid, password);
  WiFi.setSleep(false);   // sin ahorro de energía: el video no se corta

  while (WiFi.status() != WL_CONNECTED) {   // espera hasta conectarse
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.println("WiFi conectado");

  // ----------------------------------------------------------------------------
  // 7. SERVIDOR WEB
  // ----------------------------------------------------------------------------
  // Publica la página de la cámara: /         → página con controles
  //                                 /stream   → video en vivo
  //                                 /capture  → una foto JPEG
  startCameraServer();

  Serial.print("¡Cámara lista! Abre 'http://");
  Serial.print(WiFi.localIP());   // esta es la IP que se abre en el navegador
  Serial.println("' en el navegador");
}

void loop() {
  // No hace nada: el servidor web atiende las peticiones en su propia tarea
  // (FreeRTOS), así que el loop solo espera.
  delay(10000);
}
