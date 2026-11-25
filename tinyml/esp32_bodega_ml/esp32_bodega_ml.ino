/*
  TinyML en ESP32 - Bodega de café
  Pronóstico de temperatura y humedad a 5 minutos con un modelo TFLite
  entrenado en Colab (TinyML_bodega_cafe.ipynb) y ejecutado con EloquentTinyML.

  Funcionamiento:
   1. setup(): carga el modelo y lo valida con 8 ventanas reales del conjunto
      de prueba (incluidas en modelo_bodega.h): imprime predicho vs real.
   2. loop(): si USAR_SENSOR = 1, lee el DHT11 cada 10 s, guarda las últimas
      25 lecturas (4 minutos) y predice T y H dentro de 5 minutos. Con la
      predicción aplica la regla de la bodega y lanza una alerta anticipada.

  Librerías (Gestor de librerías del IDE de Arduino):
   - EloquentTinyML  (eloquentarduino)
   - tflm_esp32      (eloquentarduino)
   - DHT sensor library (Adafruit) + Adafruit Unified Sensor
*/

#include "modelo_bodega.h"     // modelo + normalización + ventanas de prueba
#include <tflm_esp32.h>
#include <eloquent_tinyml.h>
#include <DHT.h>

// ===== Configuración =====
#define USAR_SENSOR 1          // 0 = solo la validación con datos de prueba
#define DHTPIN      4          // mismo pin que el firmware de la bodega
#define DHTTYPE     DHT11
#define LED_ALERTA  2          // LED integrado en la mayoría de placas ESP32

// Regla de la bodega (igual que el servidor Flask y el firmware)
#define T_MIN 15.0
#define T_MAX 25.0
#define H_MIN 50.0
#define H_MAX 65.0

#define TF_NUM_OPS 1           // el modelo solo usa FULLY_CONNECTED
#define ARENA_SIZE 4096

Eloquent::TF::Sequential<TF_NUM_OPS, ARENA_SIZE> tf;
DHT dht(DHTPIN, DHTTYPE);

// Buffer circular con las últimas HIST_LECTURAS lecturas
float bufT[HIST_LECTURAS], bufH[HIST_LECTURAS];
int   posBuf = 0;              // posición donde se escribe la próxima lectura
int   nLecturas = 0;
unsigned long ultimaLectura = 0;

const char* estado(float t, float h) {
  return (t >= T_MIN && t <= T_MAX && h >= H_MIN && h <= H_MAX) ? "OK" : "ALERTA";
}

/*
  Predice T y H dentro de HORIZONTE_MIN minutos.
  T[], H[]: N_PUNTOS valores ordenados de más antiguo a más reciente
            (t-4min, t-3min, t-2min, t-1min, t).
  Debe construir las entradas EXACTAMENTE igual que el notebook:
  [T(t-1)-T(t), T(t-2)-T(t), T(t-3)-T(t), T(t-4)-T(t), lo mismo para H]
*/
bool predecir(const float T[], const float H[], float &tPred, float &hPred) {
  const int ult = N_PUNTOS - 1;            // índice del valor actual (t)
  const int nLags = N_PUNTOS - 1;          // 4
  float entrada[N_ENTRADAS];

  for (int k = 1; k <= nLags; k++) {
    entrada[k - 1]         = T[ult - k] - T[ult];
    entrada[nLags + k - 1] = H[ult - k] - H[ult];
  }
  for (int i = 0; i < N_ENTRADAS; i++) {
    entrada[i] = (entrada[i] - X_MEAN[i]) / X_STD[i];   // normalización
  }

  if (!tf.predict(entrada).isOk()) {
    Serial.println(tf.exception.toString());
    return false;
  }

  // La red predice el cambio normalizado -> se desnormaliza y se suma al valor actual
  tPred = T[ult] + (tf.output(0) * Y_STD[0] + Y_MEAN[0]);
  hPred = H[ult] + (tf.output(1) * Y_STD[1] + Y_MEAN[1]);
  return true;
}

void validarConDatosDePrueba() {
  Serial.println("\n=== Validación con ventanas reales del conjunto de prueba ===");
  float errT = 0, errH = 0;

  for (int i = 0; i < DEMO_N; i++) {
    float tPred, hPred;
    if (!predecir(DEMO_T[i], DEMO_H[i], tPred, hPred)) continue;

    float tAct = DEMO_T[i][N_PUNTOS - 1], hAct = DEMO_H[i][N_PUNTOS - 1];
    errT += fabs(tPred - DEMO_REAL_T[i]);
    errH += fabs(hPred - DEMO_REAL_H[i]);

    Serial.printf("[%d] Actual T=%.1f H=%.1f (%s) | +%d min -> Predicho T=%.2f H=%.2f (%s) | Real T=%.1f H=%.1f (%s)\n",
                  i, tAct, hAct, estado(tAct, hAct), HORIZONTE_MIN,
                  tPred, hPred, estado(tPred, hPred),
                  DEMO_REAL_T[i], DEMO_REAL_H[i], estado(DEMO_REAL_T[i], DEMO_REAL_H[i]));
  }
  Serial.printf("MAE en estas ventanas -> T: %.3f °C | H: %.3f %%\n", errT / DEMO_N, errH / DEMO_N);
  Serial.printf("Tiempo de predicción: %lu us\n", (unsigned long)tf.benchmark.microseconds());
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("Pronóstico de temperatura y humedad - Bodega de café");

  tf.setNumInputs(N_ENTRADAS);
  tf.setNumOutputs(N_SALIDAS);
  tf.resolver.AddFullyConnected();

  while (!tf.begin(modelo_bodega).isOk()) {
    Serial.println(tf.exception.toString());
    delay(1000);
  }
  Serial.println("Modelo cargó de forma exitosa");

  validarConDatosDePrueba();

#if USAR_SENSOR
  pinMode(LED_ALERTA, OUTPUT);
  dht.begin();
  Serial.printf("\nLeyendo el DHT11 cada %d s. La primera predicción sale tras %d lecturas (~%d min).\n",
                PERIODO_MS / 1000, HIST_LECTURAS, (HIST_LECTURAS - 1) * PERIODO_MS / 60000);
#endif
}

void loop() {
#if USAR_SENSOR
  if (millis() - ultimaLectura < PERIODO_MS) return;   // muestreo cada 10 s, como en el entrenamiento
  ultimaLectura = millis();

  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) { Serial.println("Error sensor"); return; }

  bufT[posBuf] = t;
  bufH[posBuf] = h;
  posBuf = (posBuf + 1) % HIST_LECTURAS;
  if (nLecturas < HIST_LECTURAS) nLecturas++;

  if (nLecturas < HIST_LECTURAS) {
    Serial.printf("T=%.1f H=%.1f | llenando buffer %d/%d\n", t, h, nLecturas, HIST_LECTURAS);
    return;
  }

  // Tomar un punto por minuto: t-4min ... t (cada PASO_LAG lecturas)
  float T[N_PUNTOS], H[N_PUNTOS];
  for (int j = 0; j < N_PUNTOS; j++) {
    int atras = (N_PUNTOS - 1 - j) * PASO_LAG;                         // 24, 18, 12, 6, 0
    int idx = (posBuf - 1 - atras + 2 * HIST_LECTURAS) % HIST_LECTURAS;
    T[j] = bufT[idx];
    H[j] = bufH[idx];
  }

  float tPred, hPred;
  if (!predecir(T, H, tPred, hPred)) return;

  const char* estAhora  = estado(t, h);
  const char* estFuturo = estado(tPred, hPred);
  bool anticipada = strcmp(estAhora, "OK") == 0 && strcmp(estFuturo, "ALERTA") == 0;
  digitalWrite(LED_ALERTA, strcmp(estFuturo, "ALERTA") == 0 ? HIGH : LOW);

  Serial.printf("Ahora T=%.1f H=%.1f (%s) | En %d min: T=%.2f H=%.2f (%s)%s | %lu us\n",
                t, h, estAhora, HORIZONTE_MIN, tPred, hPred, estFuturo,
                anticipada ? "  <<< ALERTA ANTICIPADA" : "",
                (unsigned long)tf.benchmark.microseconds());
#endif
}
