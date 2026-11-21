/*
  Captura de vibración del ventilador - Bodega de café
  ----------------------------------------------------
  Lee el acelerómetro MPU6050 a 100 Hz e imprime por el puerto serie
  una línea por lectura con el formato:  ax,ay,az   (en m/s²)

  Esas líneas las lee el programa "edge-impulse-data-forwarder" en el PC
  y las sube al proyecto de Edge Impulse para entrenar el modelo que
  clasifica el estado del ventilador (apagado / normal / desbalanceado / obstruido).

  IMPORTANTE: el sketch solo debe imprimir números. Cualquier otro texto
  confunde al data-forwarder.

  Conexiones (MPU6050 -> ESP32):
    VCC -> 3V3   (riel + de la protoboard)
    GND -> GND   (riel - de la protoboard)
    SDA -> D21
    SCL -> D22

  Librería: Adafruit MPU6050 (instala también Adafruit BusIO y Unified Sensor)
*/

#include <Adafruit_MPU6050.h>
#include <Wire.h>

Adafruit_MPU6050 mpu;                    // objeto del acelerómetro

// ===== Frecuencia de muestreo =====
#define FREQ_HZ    100                   // 100 lecturas por segundo
#define PERIODO_US (1000000 / FREQ_HZ)   // 10.000 microsegundos entre lecturas
unsigned long ultimo;                    // instante de la última lectura (us)

void setup() {
  Serial.begin(115200);                  // misma velocidad que usa el forwarder

  Wire.begin(21, 22);                    // bus I2C: SDA = 21, SCL = 22
  Wire.setClock(400000);                 // I2C rápido (400 kHz) para alcanzar 100 Hz

  // Si no encuentra el sensor (mal contacto o cableado), se queda avisando
  if (!mpu.begin()) {
    while (1) {
      Serial.println("MPU6050 no encontrado");
      delay(1000);
    }
  }

  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);   // rango ±4 g: suficiente para la vibración del ventilador
  mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);     // filtro interno: deja pasar hasta 44 Hz (menor que 100/2)

  ultimo = micros();                     // arranca el reloj de muestreo
}

void loop() {
  // Espera hasta que se cumpla el periodo de 10 ms
  if (micros() - ultimo < PERIODO_US) return;
  ultimo += PERIODO_US;                  // ritmo fijo, sin acumular retraso

  // Lee aceleración, giroscopio y temperatura del sensor (aquí solo usamos aceleración)
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  // Imprime  ax,ay,az  con 3 decimales
  Serial.print(a.acceleration.x, 3); Serial.print(",");
  Serial.print(a.acceleration.y, 3); Serial.print(",");
  Serial.println(a.acceleration.z, 3);
}
