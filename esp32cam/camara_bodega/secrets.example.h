// Copiar como secrets.h (misma carpeta). secrets.h NO se sube a GitHub.
#pragma once
// Rellena con tus datos. Usa un Thing/certificado PROPIO para la cámara
// (no el mismo del ESP32 principal: dos dispositivos con el mismo clientId se desconectan entre sí).

#define WIFI_SSID      "TU_WIFI"
#define WIFI_PASSWORD  "TU_CLAVE"

#define THINGNAME         "bodega1-camara"
#define AWS_IOT_ENDPOINT  "xxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com"

// Amazon Root CA 1
static const char AWS_CERT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)EOF";

// Certificado del dispositivo (xxxx-certificate.pem.crt)
static const char AWS_CERT_CRT[] PROGMEM = R"KEY(
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
)KEY";

// Llave privada (xxxx-private.pem.key)
static const char AWS_CERT_PRIVATE[] PROGMEM = R"KEY(
-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
)KEY";
