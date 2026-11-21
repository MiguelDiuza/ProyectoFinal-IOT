/*
  Prueba del modelo de Edge Impulse - Estado del ventilador
  ---------------------------------------------------------
  Lee el MPU6050 a 100 Hz durante 2 s (la misma ventana usada al entrenar),
  le pasa esos datos al modelo exportado desde Edge Impulse y muestra
  la clase detectada: apagado / normal / desbalanceado / obstruido.

  Si detecta una falla (desbalanceado u obstruido) con confianza alta,
  enciende el LED de D18.

  Requisitos:
   - Librería del modelo: Edge Impulse -> Deployment -> Arduino library
     (Sketch -> Include Library -> Add .ZIP Library...)
   - Adafruit MPU6050 (con Adafruit BusIO y Unified Sensor)

  Conexiones: igual que captura_ventilador (SDA -> D21, SCL -> D22, VCC -> 3V3, GND -> GND)
  LED de alarma: D18 (con resistencia de 220 ohm). El LED de D2 queda para la alerta de T/H
*/

// Librería generada por Edge Impulse. El nombre sale del proyecto "bodega-cafe".
// Si al compilar dice que no la encuentra, revisa el nombre exacto del .zip descargado.
#include <bodega-cafe_inferencing.h>
#include <Adafruit_MPU6050.h>
#include <Wire.h>

Adafruit_MPU6050 mpu;

#define LED_ALARMA      18     // LED de falla del ventilador (el de D2 queda para T/H)
#define UMBRAL_FALLA    0.60   // confianza mínima para dar alarma

// Buffer con la ventana completa: 200 lecturas x 3 ejes = 600 valores
// (EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE lo define la librería del modelo)
static float ventana[EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE];

void setup() {
  Serial.begin(115200);
  pinMode(LED_ALARMA, OUTPUT);

  // Mismo montaje del sensor que en la captura (debe ser idéntico al entrenamiento)
  Wire.begin(21, 22);
  Wire.setClock(400000);
  if (!mpu.begin()) {
    while (1) { Serial.println("MPU6050 no encontrado"); delay(1000); }
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);

  // Datos del modelo, leídos de la librería
  Serial.println("Modelo de Edge Impulse cargado");
  Serial.printf("Ventana: %d ms | Frecuencia: %.0f Hz | Clases: %d\n",
                EI_CLASSIFIER_RAW_SAMPLE_COUNT * (int)EI_CLASSIFIER_INTERVAL_MS,
                1000.0 / EI_CLASSIFIER_INTERVAL_MS, EI_CLASSIFIER_LABEL_COUNT);
}

void loop() {
  // ===== 1. Llenar la ventana de 2 s a 100 Hz =====
  const unsigned long periodo_us = (unsigned long)(EI_CLASSIFIER_INTERVAL_MS * 1000);  // 10.000 us
  unsigned long siguiente = micros();

  for (size_t i = 0; i < EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE; i += 3) {
    while ((long)(micros() - siguiente) < 0) { }   // espera el instante exacto de la lectura
    siguiente += periodo_us;

    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    ventana[i]     = a.acceleration.x;   // mismas unidades que en la captura (m/s²)
    ventana[i + 1] = a.acceleration.y;
    ventana[i + 2] = a.acceleration.z;
  }

  // ===== 2. Pasar la ventana al modelo =====
  signal_t senal;
  numpy::signal_from_buffer(ventana, EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE, &senal);

  ei_impulse_result_t resultado = { 0 };
  EI_IMPULSE_ERROR err = run_classifier(&senal, &resultado, false);   // Spectral Analysis + red neuronal
  if (err != EI_IMPULSE_OK) {
    Serial.printf("Error del modelo: %d\n", err);
    return;
  }

  // ===== 3. Buscar la clase con mayor probabilidad =====
  int mejor = 0;
  for (int c = 0; c < EI_CLASSIFIER_LABEL_COUNT; c++) {
    if (resultado.classification[c].value > resultado.classification[mejor].value) mejor = c;
  }
  const char* clase = resultado.classification[mejor].label;
  float confianza   = resultado.classification[mejor].value;

  // ===== 4. Alarma: falla en el ventilador =====
  bool falla = (strcmp(clase, "desbalanceado") == 0 || strcmp(clase, "obstruido") == 0)
               && confianza >= UMBRAL_FALLA;
  digitalWrite(LED_ALARMA, falla ? HIGH : LOW);

  // ===== 5. Mostrar resultado =====
  Serial.printf("Ventilador: %-13s %.2f", clase, confianza);
  for (int c = 0; c < EI_CLASSIFIER_LABEL_COUNT; c++) {       // probabilidad de cada clase
    Serial.printf(" | %s %.2f", resultado.classification[c].label, resultado.classification[c].value);
  }
  Serial.printf(" | DSP %d ms, red %d ms%s\n",
                resultado.timing.dsp, resultado.timing.classification,
                falla ? "  <<< FALLA EN VENTILADOR" : "");
}
