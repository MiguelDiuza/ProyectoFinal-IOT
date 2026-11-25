// Configuración del despliegue. Este archivo NO se compila: se puede editar directo en S3.
//   api:       URL de API Gateway (Invoke URL), sin "/" al final
//   modo:      'serverless' = AWS (API Gateway + Lambda + DynamoDB) · 'local' = backend/ con Docker
//   sondeoSeg: cada cuántos segundos se piden datos nuevos a la API
//   camaraVivo: http://<IP de la ESP32-CAM> para ver la cámara en vivo (solo en la misma red WiFi); '' = no
// Si la API no responde, el dashboard pasa solo a la demostración y lo indica arriba.
window.BODEGA_CONFIG = {
  api: '',
  modo: 'serverless',
  sondeoSeg: 5,
  camaraVivo: '',
};
