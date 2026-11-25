# TinyML – Pronóstico a 5 minutos en la bodega de café (ESP32)

## Qué hace
Con las últimas lecturas del DHT11 (un punto por minuto durante 4 minutos), el ESP32 predice la **temperatura y la humedad dentro de 5 minutos** y aplica la regla de la bodega (15–25 °C, 50–65 %) para dar una **alerta anticipada** antes de que la bodega salga de rango.

## Por qué este modelo y no otro
- **T a partir de H (o al revés):** la correlación es r = 0,29 (R² ≈ 0,08). Una regresión explicaría menos del 10 % de la variación.
- **T/H a partir de la hora:** solo hay 4 sesiones y 11 horas distintas del día; el modelo memorizaría esas tardes y no generalizaría.
- **Clasificar `estado`:** coincide al 100 % con la regla del firmware; el modelo solo aprendería un `if`.
- **Pronóstico a corto plazo:** los datos son continuos (una lectura cada 10 s), así que la tendencia reciente sí contiene información sobre el futuro inmediato.

## Resultados (conjunto de prueba, último 20 % de cada sesión)
| | MAE T (°C) | MAE H (%) |
|---|---|---|
| Persistencia ("todo sigue igual") | 0,151 | 1,227 |
| Modelo 1 – regresión lineal | 0,139 | 0,882 |
| Modelo 2 – red 16-16 (exportado) | 0,137 | 0,875 |

- La humedad mejora ~29 % frente a la persistencia; la temperatura, poco, porque casi no cambia en 5 min.
- Estado a +5 min: 98,0 % de acierto (persistencia 94,5 %). En las 30 ventanas donde el estado **cambia**, el modelo lo anticipa en el 63 % de los casos; la persistencia, en ninguno.
- Modelo TFLite: 3,8 KB, solo usa la operación `FULLY_CONNECTED`.

## Archivos
- `TinyML_bodega_cafe.ipynb`: notebook de Colab (ya ejecutado, con gráficas y resultados). Al ejecutarlo pide subir el CSV y genera `modelo_bodega.h` y `modelo_bodega.tflite`.
- `esp32_bodega_ml/esp32_bodega_ml.ino`: sketch de inferencia.
- `esp32_bodega_ml/modelo_bodega.h`: modelo + constantes de normalización + 8 ventanas reales de prueba. Si se reentrena, solo hay que reemplazar este archivo.

## Cómo subirlo al ESP32
1. Librerías (Gestor de librerías): **EloquentTinyML**, **tflm_esp32**, **DHT sensor library** (Adafruit) y **Adafruit Unified Sensor**.
2. Abrir `esp32_bodega_ml.ino` (el `.h` debe estar en la misma carpeta), elegir la placa y subir. Monitor serie a 115200.
3. DHT11 en el GPIO 4, igual que el firmware de la bodega. Con `#define USAR_SENSOR 0` solo corre la validación con datos de prueba (no necesita sensor).

**Versión de tflm_esp32:** compilado y verificado con EloquentTinyML 3.0.1.
- **ESP32-S3:** funciona con tflm_esp32 2.0.0.
- **ESP32 clásico (ESP32-WROOM / DevKit):** con tflm_esp32 2.0.0 el enlazado falla con errores `multiple definition of ...` (el problema está en la librería, no en el sketch). Se soluciona instalando **tflm_esp32 1.0.0** desde el Gestor de librerías.

## Salida esperada en el monitor serie
```
Modelo cargó de forma exitosa
=== Validación con ventanas reales del conjunto de prueba ===
[0] Actual T=23.3 H=53.4 (OK) | +5 min -> Predicho T=22.78 H=50.95 (OK) | Real T=23.0 H=49.9 (ALERTA)
...
[2] Actual T=23.0 H=51.0 (OK) | +5 min -> Predicho T=22.66 H=49.46 (ALERTA) | Real T=22.9 H=48.1 (ALERTA)
...
T=23.1 H=55.0 | llenando buffer 1/25
...
Ahora T=23.1 H=50.4 (OK) | En 5 min: T=22.80 H=49.10 (ALERTA)  <<< ALERTA ANTICIPADA | 120 us
```
Las líneas de validación son las que da el modelo actual; las líneas en vivo son un ejemplo ilustrativo del formato. La primera predicción en vivo sale tras unos 4 minutos, que es lo que tarda en llenarse el buffer. El LED del GPIO 2 se enciende cuando el estado predicho es ALERTA.

## Limitaciones
Son ~2.900 lecturas en 4 sesiones (~8 h), así que el modelo no ha visto un día completo, la noche ni cambios de clima. Con más días de datos se puede reentrenar con el mismo notebook, e incluso alargar el horizonte a 10–15 min, sin tocar el sketch.
