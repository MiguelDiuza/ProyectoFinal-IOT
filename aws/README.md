# Despliegue en AWS (Learner Lab, us-east-1)

Todo es **serverless**: AWS IoT Core → reglas de IoT → DynamoDB `bodega-lecturas`; alarmas →
Lambda `bodega-alertas` → Telegram; dashboard en S3 → API Gateway → Lambda `bodega-api`.
Formato de los mensajes: [docs/contrato-aws.md](../docs/contrato-aws.md).

| Archivo | Qué es | Estado |
|---|---|---|
| [iot/policy.json](iot/policy.json) | Política de los dispositivos | Actualizada: permite conectar también a la ESP32-CAM (`bodega1-camara`) |
| [iot/regla_lecturas.sql](iot/regla_lecturas.sql) | `bodega_guardar_lecturas` → DynamoDB | Ya existe (Act. 3) |
| [iot/regla_alertas.sql](iot/regla_alertas.sql) | `bodega_alertas_telegram` → Lambda `bodega-alertas` | Ver README principal |
| [iot/regla_guardar_alertas.sql](iot/regla_guardar_alertas.sql) | `bodega_guardar_alertas` → DynamoDB | **Nueva**: historial de alarmas en el dashboard |
| [iot/regla_camara.sql](iot/regla_camara.sql) | `bodega_guardar_camara` → DynamoDB | **Nueva**: clasificación de la ESP32-CAM |
| [lambda/bodega_alertas/](lambda/bodega_alertas/lambda_function.py) | Telegram | Ver README principal |
| [lambda/bodega_api/](lambda/bodega_api/lambda_function.py) | API del dashboard | **Reemplaza** a la de la Act. 3 (mismas rutas + `GET /dashboard`) |

## Pasos para dejar el dashboard funcionando

1. **Lambda `bodega-api`**: pegar [lambda_function.py](lambda/bodega_api/lambda_function.py) → *Deploy*.
   Variable de entorno `IOT_ENDPOINT` = `https://<id>-ats.iot.us-east-1.amazonaws.com`
   (IoT Core → Configuración). Timeout: 10 s. Si la tabla o los nombres cambian: `TABLA`,
   `ID_LECTURAS` (`bodega-esp32`), `ID_CAMARA` (`bodega1-camara`), `ID_ALERTAS` (`alertas`).
2. **API Gateway** (la HTTP API de la Act. 3): agregar la ruta **`GET /dashboard`** integrada con
   `bodega-api` (ya existen `GET /lecturas`, `GET /lecturas/csv` y `POST /led`). En *CORS*:
   origen `*`, métodos `GET, POST, OPTIONS`, encabezado `content-type`.
3. **Reglas nuevas**: `bodega_guardar_alertas` y `bodega_guardar_camara`, acción **DynamoDBv2** →
   `bodega-lecturas`, rol **LabRole**.
4. **ESP32-CAM** (cuando publique en `bodega1/camara`): crear el *Thing* `bodega1-camara` con su
   certificado y adjuntarle la política actualizada.
5. **Dashboard en S3** (bucket de la Act. 3, con sitio web estático y lectura pública):
   - Con AWS CLI, desde `dashboard/`:
     `.\desplegar-s3.ps1 -Bucket <bucket> -Api https://<API_ID>.execute-api.us-east-1.amazonaws.com`
   - O a mano: `npm ci; npm run build` en `dashboard/`, poner la URL de la API en `dist/config.js`
     y arrastrar **el contenido** de `dist/` al bucket.

   La URL de la API queda en `config.js`: si cambia, se edita ese archivo en S3, sin recompilar.

## Verificación

```bash
curl "https://<API_ID>.execute-api.us-east-1.amazonaws.com/dashboard?minutos=30"   # lecturas, camara, alertas
curl -X POST "https://<API_ID>.execute-api.us-east-1.amazonaws.com/led" -d '{"estado":"ON"}'
```

1. Cliente de prueba MQTT suscrito a `bodega1/#`: llegan lecturas (y cámara y alarmas).
2. DynamoDB → `bodega-lecturas`: items con `dispositivo` = `bodega-esp32`, `alertas` y `bodega1-camara`.
3. Dashboard en S3: arriba dice **En vivo**; el botón del LED prende el LED D19 del ESP32.
4. Una alarma (tapar el ventilador) llega a Telegram y aparece en el dashboard; cuando el
   ventilador vuelve a *normal*, el dashboard la marca como resuelta.

Learner Lab: las credenciales de la CLI caducan cada 4 h, pero los recursos y la URL de la API se
conservan entre sesiones. Todo usa el rol **LabRole**. Si la API no responde, el dashboard pasa
solo a la demostración y lo indica arriba.
