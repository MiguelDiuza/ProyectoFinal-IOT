-- Regla de IoT "bodega_guardar_lecturas" (de la Actividad 3, sin cambios)
-- Guarda cada mensaje de bodega1/lecturas (sensores + predicciones de los modelos de IA)
-- en DynamoDB, tabla bodega-lecturas (acción DynamoDBv2, rol LabRole).
SELECT *, timestamp() AS ts FROM 'bodega1/lecturas'
