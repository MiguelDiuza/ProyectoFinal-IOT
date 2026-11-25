/*
  Bodega de café pergamino - Sketch integrado SIN conexión (versión original de Juliana, solo Monitor serie)
  -----------------------------------------------------------------
  Corre los dos modelos en el mismo ESP32:

   1. Modelo T/H (TinyML, notebook TinyML_bodega_cafe.ipynb):
      DHT11 cada 10 s -> buffer de 25 lecturas (4 min) -> red 8-16-16-2
      -> pronóstico de T y H a 5 min -> alerta anticipada (LED D2).

   2. Modelo del ventilador (Edge Impulse):
      MPU6050 a 100 Hz -> ventana de 2 s -> Spectral Analysis + red
      -> apagado / normal / desbalanceado / obstruido (LED D18 si hay falla).

  Por qué la red T/H no usa EloquentTinyML/tflm_esp32:
   La librería de Edge Impulse trae su propia copia de TensorFlow Lite Micro
   (y de ESP-NN). Si además se incluye tflm_esp32, las dos copias definen las
   mismas funciones y el enlazado falla con "multiple definition of ...".
   La red T/H es pequeña (450 parámetros, solo capas densas), así que se
   ejecuta con los mismos pesos del modelo_bodega.tflite, extraídos a
   modelo_th_pesos.h. Se verificó que da exactamente las mismas salidas que
   el intérprete de TFLite en las 8 ventanas de prueba.

  Organización:
   - tareaVentilador (FreeRTOS, núcleo 1): muestrea el MPU6050 a 100 Hz con
     vTaskDelayUntil y clasifica cada ventana. No la frena nada del loop.
   - loop(): DHT11 + modelo T/H cada 10 s, LEDs y salida por serie.
     Aquí se agregan después WiFi, MQTT y el servidor MCP sin afectar el
     muestreo del acelerómetro.

  Librerías:
   - bodega-cafe_inferencing (Edge Impulse -> Deployment -> Arduino library)
   - Adafruit MPU6050 (+ Adafruit BusIO, Adafruit Unified Sensor)
   - DHT sensor library (Adafruit)
  NO incluir EloquentTinyML ni tflm_esp32 en este sketch.

  Conexiones: DHT11 -> D4 | MPU6050 SDA/SCL -> D21/D22 | LED T/H -> D2 | LED ventilador -> D18
*/

#include <bodega-cafe_inferencing.h>   // modelo del ventilador (Edge Impulse)
#include <Adafruit_MPU6050.h>
#include <Wire.h>
#include <DHT.h>
#include "modelo_bodega.h"             // normalización + ventanas de prueba del modelo T/H
#include "modelo_th_pesos.h"           // pesos de la red T/H

// ===== Pines =====
#define DHTPIN          4
#define DHTTYPE         DHT11
#define LED_TH          2              // alerta anticipada de T/H
#define LED_VENT        18             // falla del ventilador

// ===== Regla de la bodega =====
#define T_MIN 15.0
#define T_MAX 25.0
#define H_MIN 50.0
#define H_MAX 65.0

#define UMBRAL_FALLA    0.60           // confianza mínima para dar falla del ventilador

DHT dht(DHTPIN, DHTTYPE);
Adafruit_MPU6050 mpu;

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

const char* estadoTH(float t, float h) {
  return (t >= T_MIN && t <= T_MAX && h >= H_MIN && h <= H_MAX) ? "OK" : "ALERTA";
}

// ------------------------------------------------------------------
//  Modelo T/H: red 8 -> 16 (ReLU) -> 16 (ReLU) -> 2
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
//  Tarea del ventilador: 100 Hz exactos + clasificación con Edge Impulse
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

    // La clasificación tarda ~5 ms (< 10 ms), así que no se pierde el ritmo.
    // Si llegara a atrasarse, se reinicia la referencia para no leer en ráfaga.
    if ((long)(xTaskGetTickCount() - siguiente) > (long)periodo) siguiente = xTaskGetTickCount();
  }
}

// ------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("Bodega de café - modelo T/H + modelo del ventilador");

  pinMode(LED_TH, OUTPUT);
  pinMode(LED_VENT, OUTPUT);

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
  Serial.printf("DHT11 cada %d s; el primer pronóstico sale a los ~%d min\n\n",
                PERIODO_MS / 1000, (HIST_LECTURAS - 1) * PERIODO_MS / 60000);

  // Tarea del ventilador en el núcleo 1, prioridad mayor que el loop (1).
  // WiFi/MQTT corren en el núcleo 0.
  xTaskCreatePinnedToCore(tareaVentilador, "ventilador", 8192, NULL, 2, NULL, 1);

  ultimaLectura = millis() - PERIODO_MS;   // primera lectura del DHT de inmediato
}

void loop() {
  // (Aquí irán después: mantener WiFi/MQTT, atender el servidor MCP)

  if (millis() - ultimaLectura < PERIODO_MS) { delay(5); return; }
  ultimaLectura += PERIODO_MS;            // ritmo fijo de 10 s, como en el entrenamiento

  // Copia del último resultado del ventilador
  EstadoVentilador v;
  portENTER_CRITICAL(&muxVent);
  v = estVent;
  portEXIT_CRITICAL(&muxVent);

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

  Serial.printf("T=%.1f H=%.1f (%s)", t, h, estadoTH(t, h));

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
    float tP, hP;
    predecirTH(T, H, tP, hP);
    const char* estFut = estadoTH(tP, hP);
    bool anticipada = strcmp(estadoTH(t, h), "OK") == 0 && strcmp(estFut, "ALERTA") == 0;
    digitalWrite(LED_TH, strcmp(estFut, "ALERTA") == 0 ? HIGH : LOW);
    Serial.printf(" | +%d min: T=%.2f H=%.2f (%s)%s", HORIZONTE_MIN, tP, hP, estFut,
                  anticipada ? " <<< ALERTA ANTICIPADA" : "");
  }

  Serial.printf(" || Ventilador: %s %.2f | RMS acc %.3f m/s2 giro %.3f rad/s | DSP %d ms red %d ms%s\n",
                v.clase, v.confianza, v.rmsAcc, v.rmsGiro, v.msDsp, v.msRed,
                v.falla ? " <<< FALLA EN VENTILADOR" : "");
}
