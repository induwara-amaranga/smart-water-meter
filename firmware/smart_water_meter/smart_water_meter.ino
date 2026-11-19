// ==========================================
// Smart Water Meter firmware (ESP32-S3)
//
// Hardware, pins, flow measurement, buttons, OLED and SD logging are the
// original sketch. The local web server was replaced by MQTT to the backend:
//
//   publish   swm/v1/meters/{METER_ID}/up/status      online/offline (retained, Last Will)
//             .../up/telemetry   cumulative litres, flow, valve (every telemetrySec)
//             .../up/heartbeat   Wi-Fi signal, firmware, free memory (every heartbeatSec)
//             .../up/event       BOOT, VALVE_CHANGED
//             .../up/live        flow every second while the app's live view is open
//             .../up/backlog     readings stored on the SD card while offline
//             .../up/cmd-ack     command progress (RECEIVED / EXECUTED / FAILED)
//   subscribe .../down/cmd       VALVE_OPEN, VALVE_CLOSE, LIVE_ON, LIVE_OFF, REBOOT, SYNC_CONFIG
//             .../down/config    calibration and reporting intervals (retained)
//
// Libraries (Arduino Library Manager): PubSubClient (Nick O'Leary),
// ArduinoJson 7 (Benoit Blanchon), Adafruit SH110X, Adafruit GFX.
// Settings for this meter are in config.h.
// ==========================================
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include <esp_timer.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h> // SH1106 Library
#include <SPI.h>
#include <SD.h>
#include "config.h"

#define FW_VERSION "1.1.0"

// ==========================================
// ESP32-S3 Pin Definitions (unchanged)
// ==========================================
// I2C for OLED
#define I2C_SDA 8
#define I2C_SCL 9

// SPI for SD Card
#define SPI_MOSI 11
#define SPI_MISO 13
#define SPI_SCK  12
#define SD_CS    10

// Core Hardware Pins
const int flowSensorPin = 5;
const int relayPin = 4;

// User Interface Pins
const int flowLedPin = 15;
const int valveButtonPin = 6;
const int oledButtonPin = 7;

// ==========================================
// OLED Display Settings (1.3" SH1106, unchanged)
// ==========================================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define i2c_Address   0x3C
Adafruit_SH1106G display = Adafruit_SH1106G(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool oledIsOn = true;

// ==========================================
// Variables & Timers
// ==========================================
const bool isActiveLowRelay = false;
bool valveIsOpen = false;

volatile long pulseCount = 0;
unsigned long previousMillis = 0;
volatile unsigned long lastPulseTime = 0;

float flowRate = 0.0;
double totalLiters = 0.0;          // double: a float loses small increments once the total is large
float calibrationFactor = 7.5;     // pulses per second per L/min; the backend's config can override it

// SD Card Timers
unsigned long lastSummaryTime = 0;
const unsigned long summaryInterval = 180000;
unsigned long lastOfflineLogTime = 0;
const unsigned long offlineLogInterval = 10000;

// Button Debounce Variables
int valveBtnState = HIGH;
int lastValveBtnReading = HIGH;
unsigned long lastDebounceTimeValve = 0;

int oledBtnState = HIGH;
int lastOledBtnReading = HIGH;
unsigned long lastDebounceTimeOLED = 0;
const unsigned long debounceDelay = 50;

// LED Blinking Timer
unsigned long lastLedBlinkTime = 0;
bool ledState = LOW;

// ==========================================
// Cloud (MQTT) state
// ==========================================
#if MQTT_USE_TLS
WiFiClientSecure net;
#else
WiFiClient net;
#endif
PubSubClient mqtt(net);

const String topicBase = String("swm/v1/meters/") + METER_ID;
const char* BACKLOG_FILE = "/backlog.txt";   // one JSON reading per line, uploaded after reconnect
const char* SEQ_FILE = "/seq.txt";
const char* VALVE_FILE = "/valve.txt";

bool sdOk = false;
char bootId[9];                    // random per boot; lets the server date readings taken before the clock was set
uint64_t seq = 0;                  // message counter, never repeats (saved on SD)
bool seqAlignedToClock = false;

unsigned long telemetryIntervalMs = 900000UL;  // 15 min until the backend's config arrives
unsigned long heartbeatIntervalMs = 300000UL;  // 5 min
unsigned long lastTelemetryTime = 0;
unsigned long lastHeartbeatTime = 0;
unsigned long liveUntil = 0;       // millis() until which live flow is streamed

unsigned long lastWifiAttempt = 0;
unsigned long lastMqttAttempt = 0;
unsigned long mqttRetryDelay = 2000;
bool bootEventSent = false;
bool backlogPending = false;
String lastCmdId = "";

// Prototypes (default arguments must be declared before use)
void updateOLED();
bool publishUp(const char* kind, const char* payload, bool retain = false);
void sendEvent(const char* type, const char* dataKey = nullptr, const char* dataValue = nullptr);
void sendAck(const String& cmdId, const char* state, const char* valve = nullptr, const char* err = nullptr);
void sendTelemetry();

void IRAM_ATTR pulseCounter() {
  unsigned long currentMicros = micros();
  if (currentMicros - lastPulseTime > 5000) {
    pulseCount++;
    lastPulseTime = currentMicros;
  }
}

// ==========================================
// Bill Calculation Logic (unchanged; estimate shown on the OLED only.
// The official bill is calculated by the backend.)
// ==========================================
float calculateBill(float liters) {
  float units = liters / 1000.0;
  float usageCharge = 0.0;
  float serviceCharge = 0.0;

  if (units <= 5.0) {
    usageCharge = units * 10.0;
    serviceCharge = 250.0;
  } else if (units <= 10.0) {
    usageCharge = (5.0 * 10.0) + ((units - 5.0) * 10.0);
    serviceCharge = 400.0;
  } else if (units <= 15.0) {
    usageCharge = (10.0 * 10.0) + ((units - 10.0) * 15.0);
    serviceCharge = 400.0;
  } else if (units <= 20.0) {
    usageCharge = (10.0 * 10.0) + (5.0 * 15.0) + ((units - 15.0) * 22.0);
    serviceCharge = 500.0;
  } else {
    usageCharge = (10.0 * 10.0) + (5.0 * 15.0) + (5.0 * 22.0) + ((units - 20.0) * 25.0);
    serviceCharge = 500.0;
  }

  return usageCharge + serviceCharge;
}

// ==========================================
// SD Card Functions
// ==========================================
void backupVolumeToSD() {
  if (!sdOk) return;
  SD.remove("/volume.txt");
  File file = SD.open("/volume.txt", FILE_WRITE);
  if (file) {
    file.print(totalLiters, 4);
    file.close();
  }
}

void loadVolumeFromSD() {
  File file = SD.open("/volume.txt");
  if (file) {
    String val = file.readString();
    totalLiters = val.toDouble();
    file.close();
  }
}

void logToSD(String prefix) {
  if (!sdOk) return;
  File dataFile = SD.open("/water_log.txt", FILE_APPEND);
  if (dataFile) {
    unsigned long runTimeSeconds = millis() / 1000;
    float currentBill = calculateBill(totalLiters);
    dataFile.print("[");
    dataFile.print(prefix);
    dataFile.print("] Uptime: ");
    dataFile.print(runTimeSeconds);
    dataFile.print("s | Total: ");
    dataFile.print(totalLiters, 1);
    dataFile.print(" L | Bill: Rs.");
    dataFile.println(currentBill, 2);
    dataFile.close();
  }
}

void saveSeq() {
  if (!sdOk) return;
  File f = SD.open(SEQ_FILE, FILE_WRITE);
  if (f) {
    char buf[24];
    snprintf(buf, sizeof buf, "%llu", (unsigned long long)seq);
    f.print(buf);
    f.close();
  }
}

void loadSeq() {
  File f = SD.open(SEQ_FILE);
  if (f) {
    String s = f.readString();
    seq = strtoull(s.c_str(), nullptr, 10);
    f.close();
  }
  seq += 100;  // skip ahead in case the last values were not saved before a power cut
  saveSeq();
}

uint64_t nextSeq() {
  seq++;
  saveSeq();
  return seq;
}

void saveValveState() {
  if (!sdOk) return;
  File f = SD.open(VALVE_FILE, FILE_WRITE);
  if (f) {
    f.print(valveIsOpen ? "open" : "closed");
    f.close();
  }
}

void loadValveState() {
  File f = SD.open(VALVE_FILE);
  if (f) {
    String s = f.readString();
    s.trim();
    valveIsOpen = (s == "open");
    f.close();
  }
}

void appendBacklog(const char* reading) {
  if (!sdOk) return;
  File f = SD.open(BACKLOG_FILE, FILE_APPEND);
  if (f) {
    f.println(reading);
    f.close();
    backlogPending = true;
  }
}

// ==========================================
// Time: Unix seconds once NTP has set the clock, otherwise 0.
// Readings with ts = 0 are dated by the server from bootId + upMs.
// ==========================================
bool clockValid() { return time(nullptr) > 1700000000; }
uint32_t nowTs() { return clockValid() ? (uint32_t)time(nullptr) : 0; }
uint64_t uptimeMs() { return (uint64_t)(esp_timer_get_time() / 1000); }

const char* valveName() { return valveIsOpen ? "open" : "closed"; }

// ==========================================
// MQTT messages
// ==========================================
bool publishUp(const char* kind, const char* payload, bool retain) {
  if (!mqtt.connected()) return false;
  String topic = topicBase + "/up/" + kind;
  return mqtt.publish(topic.c_str(), payload, retain);
}

/** A cumulative reading. Every reading gets a new seq, so the server can drop duplicates. */
size_t buildReading(char* out, size_t len) {
  JsonDocument doc;
  doc["seq"] = nextSeq();
  doc["ts"] = nowTs();
  doc["bootId"] = bootId;
  doc["upMs"] = uptimeMs();
  doc["totalL"] = serialized(String(totalLiters, 3));
  doc["flowLpm"] = serialized(String(flowRate, 2));
  doc["valve"] = valveName();
  return serializeJson(doc, out, len);
}

/** Send a reading now, or keep it on the SD card if the broker can't be reached. */
void sendTelemetry() {
  char buf[256];
  buildReading(buf, sizeof buf);
  if (!publishUp("telemetry", buf)) appendBacklog(buf);
}

void sendHeartbeat() {
  JsonDocument doc;
  doc["ts"] = nowTs();
  doc["rssi"] = WiFi.RSSI();
  doc["fw"] = FW_VERSION;
  doc["heap"] = ESP.getFreeHeap();
  char buf[160];
  serializeJson(doc, buf, sizeof buf);
  publishUp("heartbeat", buf);
}

void sendLive() {
  char buf[96];
  snprintf(buf, sizeof buf, "{\"ts\":%lu,\"flowLpm\":%.2f,\"totalL\":%.3f}", (unsigned long)nowTs(), flowRate, totalLiters);
  publishUp("live", buf);
}

void sendEvent(const char* type, const char* dataKey, const char* dataValue) {
  JsonDocument doc;
  doc["seq"] = nextSeq();
  doc["ts"] = nowTs();
  doc["type"] = type;
  if (dataKey) doc["data"][dataKey] = dataValue;
  char buf[200];
  serializeJson(doc, buf, sizeof buf);
  publishUp("event", buf);
}

void sendAck(const String& cmdId, const char* state, const char* valve, const char* err) {
  JsonDocument doc;
  doc["cmdId"] = cmdId;
  doc["state"] = state;
  if (valve) doc["valve"] = valve;
  if (err) doc["err"] = err;
  char buf[200];
  serializeJson(doc, buf, sizeof buf);
  publishUp("cmd-ack", buf);
}

bool publishBacklogBatch(const String& items) {
  String payload = "{\"items\":[" + items + "]}";
  return publishUp("backlog", payload.c_str());
}

/**
 * Upload readings stored while offline, 20 per message. The file is deleted
 * only after every batch was sent. Sending a batch twice is harmless because
 * the server ignores readings whose seq it already has.
 */
void uploadBacklog() {
  if (!sdOk || !SD.exists(BACKLOG_FILE)) {
    backlogPending = false;
    return;
  }
  File f = SD.open(BACKLOG_FILE, FILE_READ);
  if (!f) return;

  String batch;
  batch.reserve(3400);
  int count = 0;
  int sent = 0;
  bool ok = true;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0 || line[0] != '{') continue;
    if (count > 0) batch += ',';
    batch += line;
    count++;
    if (count >= 20 || batch.length() > 3000) {
      ok = publishBacklogBatch(batch);
      if (!ok) break;
      sent += count;
      count = 0;
      batch = "";
      mqtt.loop();
    }
  }
  if (ok && count > 0) {
    ok = publishBacklogBatch(batch);
    if (ok) sent += count;
  }
  f.close();

  if (ok) {
    SD.remove(BACKLOG_FILE);
    backlogPending = false;
    Serial.printf("Backlog uploaded: %d readings\n", sent);
  } else {
    Serial.println("Backlog upload interrupted; will retry after reconnecting");
  }
}

// ==========================================
// Valve Control Logic
// ==========================================
void setValve(bool open) {
  valveIsOpen = open;
  digitalWrite(relayPin, isActiveLowRelay ? (valveIsOpen ? LOW : HIGH) : (valveIsOpen ? HIGH : LOW));
  if (oledIsOn) updateOLED();
  logToSD("VALVE SWITCHED");
  backupVolumeToSD();
  saveValveState();
  // Tell the backend right away (stored on SD as a reading if offline).
  sendEvent("VALVE_CHANGED", "valve", valveName());
  sendTelemetry();
  lastTelemetryTime = millis();
}

void toggleValveCoreLogic() {
  setValve(!valveIsOpen);
}

// ==========================================
// Commands and config from the backend
// ==========================================
void handleCommand(JsonDocument& doc) {
  // Copy everything out first: publishing reuses PubSubClient's buffer.
  String cmdId = doc["cmdId"] | "";
  String type = doc["type"] | "";
  uint32_t expiresAt = doc["expiresAt"] | 0;
  uint32_t ttlSec = doc["args"]["ttlSec"] | 120;
  if (cmdId.length() == 0) return;

  // Same command delivered twice: confirm again, don't act twice.
  if (cmdId == lastCmdId) {
    sendAck(cmdId, "EXECUTED", valveName());
    return;
  }
  if (expiresAt > 0 && clockValid() && expiresAt < nowTs()) {
    sendAck(cmdId, "FAILED", valveName(), "Command expired before it reached the meter");
    return;
  }
  lastCmdId = cmdId;
  sendAck(cmdId, "RECEIVED");
  Serial.printf("Command %s (%s)\n", type.c_str(), cmdId.c_str());

  if (type == "VALVE_OPEN" || type == "VALVE_CLOSE") {
    setValve(type == "VALVE_OPEN");
    sendAck(cmdId, "EXECUTED", valveName());
  } else if (type == "LIVE_ON") {
    liveUntil = millis() + ttlSec * 1000UL;
    sendAck(cmdId, "EXECUTED");
  } else if (type == "LIVE_OFF") {
    liveUntil = millis();
    sendAck(cmdId, "EXECUTED");
  } else if (type == "SYNC_CONFIG") {
    sendAck(cmdId, "EXECUTED");  // config is retained, so the latest one has already been applied
  } else if (type == "REBOOT") {
    sendAck(cmdId, "EXECUTED");
    logToSD("REMOTE REBOOT");
    backupVolumeToSD();
    String statusTopic = topicBase + "/up/status";
    mqtt.publish(statusTopic.c_str(), "{\"online\":false}", true);
    mqtt.disconnect();
    delay(200);
    ESP.restart();
  } else {
    sendAck(cmdId, "FAILED", nullptr, "Unsupported command");
  }
}

void applyConfig(JsonDocument& doc) {
  float cal = doc["calFactor"] | 0.0f;
  uint32_t telemetrySec = doc["telemetrySec"] | 0;
  uint32_t heartbeatSec = doc["heartbeatSec"] | 0;
  if (cal > 0.5f && cal < 100.0f) calibrationFactor = cal;
  if (telemetrySec >= 10) telemetryIntervalMs = telemetrySec * 1000UL;
  if (heartbeatSec >= 10) heartbeatIntervalMs = heartbeatSec * 1000UL;
  Serial.printf("Config: calFactor=%.2f telemetry=%lus heartbeat=%lus\n", calibrationFactor,
                telemetryIntervalMs / 1000, heartbeatIntervalMs / 1000);
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  String t(topic);
  String kind = t.substring(t.lastIndexOf('/') + 1);
  JsonDocument doc;
  if (deserializeJson(doc, (const char*)payload, length)) {
    Serial.printf("Ignoring invalid JSON on %s\n", topic);
    return;
  }
  if (kind == "cmd") handleCommand(doc);
  else if (kind == "config") applyConfig(doc);
}

// ==========================================
// Connections (non-blocking: the meter keeps measuring while offline)
// ==========================================
void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiAttempt < 30000) return;
  lastWifiAttempt = millis();
  Serial.println("Wi-Fi down, reconnecting...");
  WiFi.reconnect();
}

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - lastMqttAttempt < mqttRetryDelay) return;
  lastMqttAttempt = millis();

  String clientId = String("meter-") + METER_ID;
  String statusTopic = topicBase + "/up/status";
  // Identity is the client ID + username + secret, not the IP address.
  // The Last Will marks the meter offline if the connection dies.
  bool ok = mqtt.connect(clientId.c_str(), METER_ID, DEVICE_SECRET,
                         statusTopic.c_str(), 1, true, "{\"online\":false}");
  if (!ok) {
    int state = mqtt.state();
    if (state == 4 || state == 5) Serial.println("MQTT refused: check METER_ID and DEVICE_SECRET in config.h");
    else Serial.printf("MQTT connect failed (state %d)\n", state);
    mqttRetryDelay = min(mqttRetryDelay * 2, 60000UL);
    return;
  }

  mqttRetryDelay = 2000;
  Serial.println("MQTT connected");
  char status[96];
  snprintf(status, sizeof status, "{\"online\":true,\"fw\":\"%s\",\"bootId\":\"%s\"}", FW_VERSION, bootId);
  mqtt.publish(statusTopic.c_str(), status, true);
  mqtt.subscribe((topicBase + "/down/#").c_str(), 1);  // again on every connect (clean session)

  if (!bootEventSent) {
    sendEvent("BOOT", "bootId", bootId);
    bootEventSent = true;
  }
  if (backlogPending) uploadBacklog();
  sendTelemetry();
  sendHeartbeat();
  lastTelemetryTime = millis();
  lastHeartbeatTime = millis();
}

// ==========================================
// OLED Update Routine
// ==========================================
void updateOLED() {
  if (!oledIsOn) return;

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SH110X_WHITE);
  display.setCursor(0, 0);
  display.print("VALVE: ");
  display.print(valveIsOpen ? "OPEN" : "CLOSED");
  // Cloud connection, top right
  bool online = mqtt.connected();
  display.setCursor(online ? 92 : 86, 0);
  display.print(online ? "ONLINE" : "OFFLINE");
  display.drawLine(0, 10, 128, 10, SH110X_WHITE);

  bool showPrimaryScreen = (millis() / 5000) % 2 == 0;

  if (showPrimaryScreen) {
    display.setTextSize(1);
    display.setCursor(0, 14);
    display.print("FLOW (L/min):");
    display.drawRect(0, 24, 128, 16, SH110X_WHITE);
    display.setTextSize(2);
    display.setCursor(4, 25);
    display.print(flowRate, 1);

    display.setTextSize(1);
    display.setCursor(0, 42);
    display.print("VOLUME (Liters):");
    display.drawRect(0, 50, 128, 14, SH110X_WHITE);
    display.setTextSize(1);
    display.setCursor(4, 53);
    display.print(totalLiters, 1);
  } else {
    float units = totalLiters / 1000.0;
    float currentBill = calculateBill(totalLiters);

    display.setTextSize(1);
    display.setCursor(0, 14);
    display.print("USAGE (Cu.M):");
    display.drawRect(0, 24, 128, 16, SH110X_WHITE);
    display.setTextSize(2);
    display.setCursor(4, 25);
    display.print(units, 3);

    display.setTextSize(1);
    display.setCursor(0, 42);
    display.print("BILL (Rs):");
    display.drawRect(0, 50, 128, 14, SH110X_WHITE);
    display.setTextSize(1);
    display.setCursor(4, 53);
    display.print(currentBill, 2);
  }
  display.display();
}

void setup() {
  Serial.begin(115200);
  snprintf(bootId, sizeof bootId, "%08lx", (unsigned long)esp_random());

  // Setup Hardware UI Pins
  pinMode(flowLedPin, OUTPUT);
  pinMode(valveButtonPin, INPUT_PULLUP);
  pinMode(oledButtonPin, INPUT_PULLUP);
  digitalWrite(flowLedPin, LOW);

  // Initialize Custom S3 SPI and I2C
  Wire.begin(I2C_SDA, I2C_SCL);
  SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI, SD_CS);

  pinMode(flowSensorPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(flowSensorPin), pulseCounter, FALLING);
  pinMode(relayPin, OUTPUT);
  digitalWrite(relayPin, isActiveLowRelay ? HIGH : LOW);

  // Initialize 1.3" SH1106 Display
  if (!display.begin(i2c_Address, true)) {
    Serial.println("OLED allocation failed");
    for (;;);
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SH110X_WHITE);
  display.setCursor(0, 10);
  display.println("Mounting SD...");
  display.display();

  if (!SD.begin(SD_CS)) {
    display.setCursor(0, 30);
    display.println("SD FAILED!");
  } else {
    sdOk = true;
    display.setCursor(0, 30);
    display.println("SD OK!");
    loadVolumeFromSD();
    loadSeq();
    loadValveState();
    backlogPending = SD.exists(BACKLOG_FILE);
    logToSD("SYSTEM BOOT");
  }
  display.display();
  delay(1500);

  // Restore the valve to its last state (a power cut must not reopen a supply
  // the water board cut, or close a supply that was on).
  digitalWrite(relayPin, isActiveLowRelay ? (valveIsOpen ? LOW : HIGH) : (valveIsOpen ? HIGH : LOW));

  // Clock (UTC) for reading timestamps; syncs in the background once Wi-Fi is up.
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  // MQTT client
#if MQTT_USE_TLS
  net.setCACert(MQTT_CA_CERT);
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setKeepAlive(60);       // broker marks the meter offline after ~90 s of silence
  mqtt.setSocketTimeout(10);
  mqtt.setBufferSize(4096);    // backlog batches are larger than the 256-byte default

  // Connect to Wi-Fi
  display.clearDisplay();
  display.setCursor(0, 10);
  display.println("Connecting Wi-Fi...");
  display.display();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int wifi_retries = 0;

  // Try for 10 seconds, then carry on offline; loop() keeps retrying.
  while (WiFi.status() != WL_CONNECTED && wifi_retries < 20) {
    delay(500);
    wifi_retries++;
  }
  lastWifiAttempt = millis();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected! IP address: ");
    Serial.println(WiFi.localIP());

    display.clearDisplay();
    display.setCursor(0, 10);
    display.println("Wi-Fi Connected!");
    display.setCursor(0, 30);
    display.println("Meter ID:");
    display.setCursor(0, 45);
    display.println(METER_ID);
    display.display();
    delay(2000);
  } else {
    Serial.println("Wi-Fi Failed. Running Offline.");
    display.clearDisplay();
    display.setCursor(0, 10);
    display.println("Wi-Fi Failed!");
    display.setCursor(0, 30);
    display.println("Running Offline...");
    display.display();
    delay(3000);
  }

  previousMillis = millis();
  lastTelemetryTime = millis();
  lastHeartbeatTime = millis();
  updateOLED();
}

void loop() {
  maintainWiFi();
  connectMqtt();
  if (mqtt.connected()) mqtt.loop();

  unsigned long currentMillis = millis();

  // Once NTP has set the clock, move seq up to clock-based values so it keeps
  // increasing even if the SD card is replaced.
  if (!seqAlignedToClock && clockValid()) {
    uint64_t clockSeq = (uint64_t)time(nullptr) * 10ULL;
    if (seq < clockSeq) {
      seq = clockSeq;
      saveSeq();
    }
    seqAlignedToClock = true;
  }

  // ==========================================
  // Physical Button: Valve Manual Override
  // ==========================================
  int readingValve = digitalRead(valveButtonPin);
  if (readingValve != lastValveBtnReading) {
    lastDebounceTimeValve = currentMillis;
  }
  if ((currentMillis - lastDebounceTimeValve) > debounceDelay) {
    if (readingValve != valveBtnState) {
      valveBtnState = readingValve;
      if (valveBtnState == LOW) {
        toggleValveCoreLogic();
      }
    }
  }
  lastValveBtnReading = readingValve;

  // ==========================================
  // Physical Button: OLED Screen Toggle
  // ==========================================
  int readingOLED = digitalRead(oledButtonPin);
  if (readingOLED != lastOledBtnReading) {
    lastDebounceTimeOLED = currentMillis;
  }
  if ((currentMillis - lastDebounceTimeOLED) > debounceDelay) {
    if (readingOLED != oledBtnState) {
      oledBtnState = readingOLED;
      if (oledBtnState == LOW) {
        oledIsOn = !oledIsOn;
        if (!oledIsOn) {
          display.clearDisplay();
          display.display();
        } else {
          updateOLED();
        }
      }
    }
  }
  lastOledBtnReading = readingOLED;

  // ==========================================
  // Flow Indicator LED Blinking
  // ==========================================
  if (flowRate > 0.0) {
    if (currentMillis - lastLedBlinkTime >= 200) {
      lastLedBlinkTime = currentMillis;
      ledState = !ledState;
      digitalWrite(flowLedPin, ledState);
    }
  } else {
    ledState = LOW;
    digitalWrite(flowLedPin, LOW);
  }

  // ==========================================
  // Flow Calculation Routine
  // Volume is counted from pulses, so nothing is lost if the loop was
  // briefly held up (for example while connecting to the broker).
  // ==========================================
  if (currentMillis - previousMillis >= 1000) {
    noInterrupts();
    long pulses = pulseCount;
    pulseCount = 0;
    interrupts();
    float elapsedSec = (currentMillis - previousMillis) / 1000.0;
    previousMillis = currentMillis;

    flowRate = (pulses / elapsedSec) / calibrationFactor;
    totalLiters += pulses / (calibrationFactor * 60.0);
    if (oledIsOn) updateOLED();

    if ((long)(liveUntil - currentMillis) > 0) sendLive();
  }

  // ==========================================
  // Cloud reporting
  // ==========================================
  if (currentMillis - lastTelemetryTime >= telemetryIntervalMs) {
    lastTelemetryTime = currentMillis;
    sendTelemetry();  // goes to the SD backlog if offline
  }
  if (mqtt.connected() && currentMillis - lastHeartbeatTime >= heartbeatIntervalMs) {
    lastHeartbeatTime = currentMillis;
    sendHeartbeat();
  }

  // ==========================================
  // SD Card Routine
  // ==========================================
  if (currentMillis - lastSummaryTime >= summaryInterval) {
    logToSD("SUMMARY");
    backupVolumeToSD();
    lastSummaryTime = currentMillis;
  }

  if (!mqtt.connected()) {
    if (currentMillis - lastOfflineLogTime >= offlineLogInterval) {
      logToSD("OFFLINE");
      backupVolumeToSD();
      lastOfflineLogTime = currentMillis;
    }
  }
}
