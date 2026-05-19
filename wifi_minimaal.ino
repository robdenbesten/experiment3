#define LED_PIN 21 // Change this if your onboard LED is on a different pin

enum WifiLedStatus {
  WIFI_LED_CONNECTING,
  WIFI_LED_CONNECTED,
  WIFI_LED_FAILED
};

void setLedColor(WifiLedStatus status, bool blinkState = false) {
  // For a single-color onboard LED, we simulate colors:
  // Green = ON, Red = fast blink, Yellow = slow blink
  // If you have an RGB LED, you can expand this logic.
  switch (status) {
    case WIFI_LED_CONNECTED:
      digitalWrite(LED_PIN, HIGH); // ON (green)
      break;
    case WIFI_LED_CONNECTING:
      digitalWrite(LED_PIN, blinkState ? HIGH : LOW); // Blinking (yellow)
      break;
    case WIFI_LED_FAILED:
      digitalWrite(LED_PIN, LOW); // OFF (red, or always off)
      break;
  }
}
#include <HardwareSerial.h>
#include <TinyGPSPlus.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <qmc5883p.h>

const char* WIFI_SSID     = "Gringo Burru";
const char* WIFI_PASSWORD = "Campina1";


static const int RX_PIN = 44;
static const int TX_PIN = 43;
static const uint32_t GPS_BAUD = 9600;
static const int I2C_SDA_PIN = 9;
static const int I2C_SCL_PIN = 8;

TinyGPSPlus gps;
HardwareSerial gpsSerial(1);
WebServer server(80);
QMC5883P mag;

double prevLat = 0, prevLon = 0;
bool   hasPrev = false;
double lastDist = 0;
unsigned long lastCalc = 0;
unsigned long lastHeadingRead = 0;

bool  headingValid = false;
float headingDeg   = 0.0f;
bool  magReady = false;

bool readHeading(float& outHeadingDeg) {
  float xyz[3];
  if (!mag.readXYZ(xyz)) return false;
  float x = xyz[0];
  float y = xyz[1];
  if (x == 0.0f && y == 0.0f) return false;
  float heading = atan2(y, x) * 180.0f / PI;
  if (heading < 0.0f) heading += 360.0f;
  outHeadingDeg = heading;
  return true;
}

const char ROOT_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPS Tracker</title>
  <link rel="stylesheet" href="https://robdenbesten.github.io/experiment3/style.css">
</head>
<body>
  <div id="app"><p style="font-family:sans-serif;color:#eee;background:#1a1a2e;margin:0;padding:16px">Loading...</p></div>
  <script src="https://robdenbesten.github.io/experiment3/app.js"></script>
</body>
</html>
)rawliteral";

void handleRoot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send_P(200, "text/html", ROOT_HTML);
}

void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin",          "*");
  server.sendHeader("Access-Control-Allow-Methods",         "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.send(204);
}

void handleData() {
  char json[320];
  snprintf(json, sizeof(json),
    "{\"fix\":%s,\"lat\":%.6f,\"lon\":%.6f,\"dist\":%.2f,"
    "\"alt_valid\":%s,\"alt\":%.1f,"
    "\"sats_valid\":%s,\"sats\":%d,"
    "\"spd_valid\":%s,\"spd\":%.2f,"
    "\"heading_valid\":%s,\"heading\":%.1f}",
    gps.location.isValid()   ? "true" : "false",
    gps.location.isValid()   ? gps.location.lat()         : 0.0,
    gps.location.isValid()   ? gps.location.lng()         : 0.0,
    lastDist,
    gps.altitude.isValid()   ? "true" : "false",
    gps.altitude.isValid()   ? gps.altitude.meters()      : 0.0,
    gps.satellites.isValid() ? "true" : "false",
    gps.satellites.isValid() ? (int)gps.satellites.value(): 0,
    gps.speed.isValid()      ? "true" : "false",
    gps.speed.isValid()      ? gps.speed.kmph()           : 0.0,
    headingValid             ? "true" : "false",
    headingValid             ? headingDeg                 : 0.0
  );
  server.sendHeader("Access-Control-Allow-Origin",          "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.send(200, "application/json", json);
}

void setup() {
    pinMode(LED_PIN, OUTPUT);
    setLedColor(WIFI_LED_CONNECTING, false);
  Serial.begin(115200);
  delay(100);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  magReady = mag.begin();
  if (magReady) {
    Serial.println("Magnetometer initialized (QMC5883P path) on SDA=9, SCL=8");
  } else {
    Serial.println("Warning: magnetometer init failed. Heading updates disabled.");
  }


  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.mode(WIFI_STA);
  delay(100);


  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting");
  unsigned long connectStart = millis();
  bool ledBlink = false;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    ledBlink = !ledBlink;
    setLedColor(WIFI_LED_CONNECTING, ledBlink);
    if (millis() - connectStart > 15000) { // 15 seconds timeout
      Serial.println("\nWiFi connection failed!");
      setLedColor(WIFI_LED_FAILED);
      break;
    }
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\nIP: ");
    Serial.println(WiFi.localIP());
    Serial.print("Open on phone: http://");
    Serial.println(WiFi.localIP());
    setLedColor(WIFI_LED_CONNECTED);
  }


  server.on("/",     HTTP_GET,     handleRoot);
  server.on("/data", HTTP_GET,     handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.begin();
  Serial.println("Ready.");

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, RX_PIN, TX_PIN);
}

void loop() {
  static unsigned long lastBlink = 0;
  static bool blinkState = false;
  if (WiFi.status() != WL_CONNECTED) {
    // Try to reconnect and blink yellow
    if (millis() - lastBlink > 500) {
      blinkState = !blinkState;
      setLedColor(WIFI_LED_CONNECTING, blinkState);
      lastBlink = millis();
    }
    // Optionally, try to reconnect here if desired
    // WiFi.reconnect();
    delay(10);
    return;
  } else {
    setLedColor(WIFI_LED_CONNECTED);
  }
  server.handleClient();
  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
  }
  if (millis() - lastHeadingRead >= 100) {
    lastHeadingRead = millis();
    if (magReady) {
      float h = 0.0f;
      headingValid = readHeading(h);
      if (headingValid) headingDeg = h;
    } else {
      headingValid = false;
    }
  }
  if (millis() - lastCalc >= 1000) {
    lastCalc = millis();
    if (gps.location.isValid()) {
      double lat = gps.location.lat();
      double lon = gps.location.lng();
      if (hasPrev) {
        lastDist = TinyGPSPlus::distanceBetween(prevLat, prevLon, lat, lon);
      }
      prevLat = lat;
      prevLon = lon;
      hasPrev = true;
    }
  }
}
