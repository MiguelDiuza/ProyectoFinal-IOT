// Copiar este archivo como secrets.h (en la misma carpeta) y poner los datos reales.
// secrets.h NO se sube a GitHub: contiene la clave del WiFi y la llave privada del dispositivo.
// Son los mismos datos de la Actividad 3 (thing bodega-esp32 en AWS IoT Core).
#define WIFI_SSID "NOMBRE_WIFI"            // red de 2,4 GHz
#define WIFI_PASS "CLAVE_WIFI"

// IoT Core -> Configuración (iot:Data-ATS)  o en CloudShell:
//   aws iot describe-endpoint --endpoint-type iot:Data-ATS
#define AWS_ENDPOINT "xxxxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com"
#define THING_NAME "bodega-esp32"          // igual al Thing y a la política

// Contenido completo de AmazonRootCA1.pem
static const char AWS_CERT_CA[] = R"EOF(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)EOF";

// Contenido completo de ...-certificate.pem.crt
static const char AWS_CERT_CRT[] = R"EOF(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)EOF";

// Contenido completo de ...-private.pem.key
static const char AWS_CERT_PRIVATE[] = R"EOF(
-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
)EOF";
