#include <HardwareSerial.h>
#include <TinyGPSPlus.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <qmc5883p.h>
#include <Preferences.h>

const char* WIFI_SSID     = "Gringo Burru";
const char* WIFI_PASSWORD = "Campina1";

// Fixed IP for phone hotspot use. Adjust these if your hotspot uses
// another range.
IPAddress FIXED_IP(10, 200, 126, 66);
IPAddress FIXED_GATEWAY(10, 200, 126, 1);
IPAddress FIXED_SUBNET(255, 255, 255, 0);

static const int RX_PIN = 44;
static const int TX_PIN = 43;
static const uint32_t GPS_BAUD = 9600;
static const int I2C_SDA_PIN = 9;
static const int I2C_SCL_PIN = 8;

TinyGPSPlus gps;
HardwareSerial gpsSerial(1);
WebServer server(80);
QMC5883P mag;
Preferences preferences;

// Calibration state
bool calibrating = false;
unsigned long calibrationStart = 0;
const unsigned long calibrationDuration = 10000; // 10 seconds
float minX = 1e6, maxX = -1e6;
float minY = 1e6, maxY = -1e6;
float minZ = 1e6, maxZ = -1e6;
float offX = 0, offY = 0, offZ = 0;
bool calibrationLoadedFromStorage = false;

const char* calibrationNs = "magcal";
const char* keyCalValid = "valid";
const char* keyOffX = "offX";
const char* keyOffY = "offY";
const char* keyOffZ = "offZ";

double prevLat = 0, prevLon = 0;
bool   hasPrev = false;
double lastDist = 0;
unsigned long lastCalc = 0;
unsigned long lastHeadingRead = 0;

bool  headingValid = false;
float headingDeg   = 0.0f;

bool loadCalibrationFromStorage() {
  bool loaded = false;
  if (!preferences.begin(calibrationNs, true)) {
    Serial.println("Calibration storage open (read) failed");
    return false;
  }

  bool valid = preferences.getBool(keyCalValid, false);
  if (valid) {
    offX = preferences.getFloat(keyOffX, 0.0f);
    offY = preferences.getFloat(keyOffY, 0.0f);
    offZ = preferences.getFloat(keyOffZ, 0.0f);
    loaded = true;
  }

  preferences.end();
  return loaded;
}

void saveCalibrationToStorage() {
  if (!preferences.begin(calibrationNs, false)) {
    Serial.println("Calibration storage open (write) failed");
    return;
  }

  preferences.putFloat(keyOffX, offX);
  preferences.putFloat(keyOffY, offY);
  preferences.putFloat(keyOffZ, offZ);
  preferences.putBool(keyCalValid, true);
  preferences.end();
}

void startCalibration() {
  calibrating = true;
  minX = 1e6; maxX = -1e6;
  minY = 1e6; maxY = -1e6;
  minZ = 1e6; maxZ = -1e6;
  calibrationStart = millis();
  Serial.println("Calibration started via web interface");
}

bool readHeading(float& outHeadingDeg) {
  float xyz[3];
  if (!mag.readXYZ(xyz)) return false;

  // Apply calibration offsets
  float x = xyz[0] - offX;
  float y = xyz[1] - offY;
  float z = xyz[2] - offZ;

  if (x == 0.0f && y == 0.0f) return false;

  float heading = atan2(y, x) * 180.0f / PI;
  if (heading < 0.0f) heading += 360.0f;
  outHeadingDeg = heading;
  return true;
}

// Minimal bootstrap page — CSS and JS are loaded from GitHub Pages (HTTPS is
// fine for an HTTP page). app.js uses window.location.hostname to reach back
// to this ESP32, so no IP needs to be hardcoded anywhere.
const char ROOT_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPS Tracker</title>
</head>
<body>
  <div id="app"><p style="font-family:sans-serif;color:#eee;background:#1a1a2e;margin:0;padding:16px">Loading...</p></div>
  <script>
  (function () {
    var BASE = 'https://robdenbesten.github.io/experiment3/';
    var bust = Date.now();

    function injectCSS(css) {
      var el = document.createElement('style');
      el.textContent = css;
      document.head.appendChild(el);
    }
    function injectJS(js) {
      var el = document.createElement('script');
      el.textContent = js;
      document.head.appendChild(el);
    }

    // Always fetch latest files; no localStorage cache to avoid stale app code.
    fetch(BASE + 'style.css?v=' + bust)
      .then(function (r) { return r.text(); })
      .then(function (t) { injectCSS(t); })
      .catch(function () {});
    fetch(BASE + 'app.js?v=' + bust)
      .then(function (r) { return r.text(); })
      .then(function (t) { injectJS(t); })
      .catch(function () {});
  })();
  </script>
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

void handleCalibrate() {
  server.sendHeader("Access-Control-Allow-Origin",          "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  
  if (server.method() == HTTP_POST || server.method() == HTTP_GET) {
    startCalibration();
    server.send(200, "application/json", "{\"status\":\"calibrating\"}");
  } else {
    server.send(405);
  }
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
  Serial.begin(115200);
  delay(100);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  if (mag.begin()) {
    Serial.println("Magnetometer initialized (QMC5883P path) on SDA=9, SCL=8");
    calibrationLoadedFromStorage = loadCalibrationFromStorage();
    if (calibrationLoadedFromStorage) {
      Serial.printf("Loaded calibration offsets: X=%.2f, Y=%.2f, Z=%.2f\n", offX, offY, offZ);
    } else {
      Serial.println("No saved calibration found. Click calibrate button to start.");
    }
  } else {
    Serial.println("Warning: magnetometer init failed.");
  }

  // ── WiFi first, nothing else ──────────────────────────────────────────────
  WiFi.persistent(false);   // don't read/write flash; prevents state corruption
  WiFi.setAutoReconnect(true);
  WiFi.mode(WIFI_STA);
  delay(100);               // let radio settle after mode switch

  if (!WiFi.config(FIXED_IP, FIXED_GATEWAY, FIXED_SUBNET)) {
    Serial.println("Warning: fixed IP configuration failed.");
  }

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.print("\nIP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Open on phone: http://");
  Serial.println(WiFi.localIP());

  server.on("/",     HTTP_GET,     handleRoot);
  server.on("/data", HTTP_GET,     handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.on("/calibrate", HTTP_GET,     handleCalibrate);
  server.on("/calibrate", HTTP_POST,    handleCalibrate);
  server.on("/calibrate", HTTP_OPTIONS, handleOptions);
  server.begin();
  Serial.println("Ready.");

  // ── GPS serial after WiFi is up ───────────────────────────────────────────
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, RX_PIN, TX_PIN);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    delay(500);  // setAutoReconnect handles it; just wait
    return;
  }

  server.handleClient();

  // Handle magnetometer calibration
  if (calibrating) {
    float xyz[3];
    if (mag.readXYZ(xyz)) {
      float x = xyz[0];
      float y = xyz[1];
      float z = xyz[2];

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    if (millis() - calibrationStart > calibrationDuration) {
      calibrating = false;
      offX = (minX + maxX) / 2.0;
      offY = (minY + maxY) / 2.0;
      offZ = (minZ + maxZ) / 2.0;
      saveCalibrationToStorage();
      Serial.println("Calibration complete");
      Serial.printf("Offsets: X=%.2f, Y=%.2f, Z=%.2f\n", offX, offY, offZ);
    }
    delay(10);
    return;
  }

  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
  }

  if (millis() - lastHeadingRead >= 100) {
    lastHeadingRead = millis();
    float h = 0.0f;
    headingValid = readHeading(h);
    if (headingValid) headingDeg = h;
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