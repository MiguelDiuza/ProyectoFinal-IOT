-- Regla de IoT "bodega_alertas_telegram"
-- Cada alarma generada por la IA en el ESP32 (bodega1/alertas) invoca la Lambda bodega-alertas,
-- que la envía por Telegram.
SELECT * FROM 'bodega1/alertas'
