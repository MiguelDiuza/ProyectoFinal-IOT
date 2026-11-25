-- Regla de IoT "bodega_guardar_alertas" (nueva; la de Telegram sigue igual en regla_alertas.sql)
-- Guarda cada alarma de bodega1/alertas en DynamoDB, tabla bodega-lecturas (acción DynamoDBv2,
-- rol LabRole), para que el dashboard muestre el historial.
-- Se listan los campos (sin *) para que "dispositivo" quede como 'alertas' y no se mezcle con
-- las lecturas del ESP32; el dispositivo que la generó queda en "origen".
SELECT 'alertas' AS dispositivo, timestamp() AS ts, tipo, mensaje, dispositivo AS origen
FROM 'bodega1/alertas'
