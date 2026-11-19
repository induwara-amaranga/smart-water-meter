// Template for config.h. Copy it to config.h and fill in the values for one meter.
#pragma once

#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-wifi-password"

#define METER_ID       "SWM-000000"          // from the registration slip
#define DEVICE_SECRET  "meter-secret"        // from the registration slip

#define MQTT_HOST      "192.168.1.10"        // or "mqtt.yourdomain.lk"
#define MQTT_PORT      1883                  // 8883 with TLS
#define MQTT_USE_TLS   0                     // 1 in production

static const char MQTT_CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
paste the CA certificate here
-----END CERTIFICATE-----
)PEM";
