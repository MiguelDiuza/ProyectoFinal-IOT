-- Regla de IoT "bodega_guardar_camara" (nueva)
-- Guarda cada clasificación de la ESP32-CAM (bodega1/camara) en DynamoDB, tabla bodega-lecturas
-- (acción DynamoDBv2, rol LabRole). La cámara publica "dispositivo":"esp32cam-01", que queda como
-- clave de partición aparte de las lecturas del ESP32.
SELECT *, timestamp() AS ts FROM 'bodega1/camara'
