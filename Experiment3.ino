#include <HardwareSerial.h>
#include <TinyGPSPlus.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>

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

static const uint8_t HMC5883_ADDR = 0x1E;
static const uint8_t QMC5883_ADDR = 0x0D;

TinyGPSPlus gps;
HardwareSerial gpsSerial(1);
WebServer server(80);

double prevLat = 0, prevLon = 0;
bool   hasPrev = false;
double lastDist = 0;
unsigned long lastCalc = 0;
unsigned long lastHeadingRead = 0;

bool  headingValid = false;
float headingDeg   = 0.0f;

enum MagType {
  MAG_NONE,
  MAG_HMC5883,
  MAG_QMC5883
};

MagType magType = MAG_NONE;

bool writeMagRegister(uint8_t addr, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool initHMC5883() {
  // Config A: 8-sample average, 15 Hz output rate, normal measurement
  if (!writeMagRegister(HMC5883_ADDR, 0x00, 0x70)) return false;
  // Config B: gain setting (default, +/-1.3 Ga)
  if (!writeMagRegister(HMC5883_ADDR, 0x01, 0x20)) return false;
  // Mode: continuous measurement
  if (!writeMagRegister(HMC5883_ADDR, 0x02, 0x00)) return false;
  return true;
}

bool initQMC5883() {
  // Soft reset
  if (!writeMagRegister(QMC5883_ADDR, 0x0A, 0x80)) return false;
  delay(10);
  // Continuous mode, ODR=200Hz, RNG=8G, OSR=512
  if (!writeMagRegister(QMC5883_ADDR, 0x09, 0x1D)) return false;
  // Set/Reset period recommended value
  if (!writeMagRegister(QMC5883_ADDR, 0x0B, 0x01)) return false;
  return true;
}

bool readHeadingHMC5883(float& outHeadingDeg) {
  Wire.beginTransmission(HMC5883_ADDR);
  Wire.write(0x03); // X_MSB register
  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  int readCount = Wire.requestFrom((int)HMC5883_ADDR, 6);
  if (readCount != 6) {
    return false;
  }

  int16_t x = (int16_t)((Wire.read() << 8) | Wire.read());
  int16_t z = (int16_t)((Wire.read() << 8) | Wire.read());
  int16_t y = (int16_t)((Wire.read() << 8) | Wire.read());
  (void)z;

  if (x == 0 && y == 0) {
    return false;
  }

  float heading = atan2((float)y, (float)x) * 180.0f / PI;
  if (heading < 0.0f) {
    heading += 360.0f;
  }
  outHeadingDeg = heading;
  return true;
}

bool readHeadingQMC5883(float& outHeadingDeg) {
  Wire.beginTransmission(QMC5883_ADDR);
  Wire.write(0x00); // X_LSB register
  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  int readCount = Wire.requestFrom((int)QMC5883_ADDR, 6);
  if (readCount != 6) {
    return false;
  }

  int16_t x = (int16_t)(Wire.read() | (Wire.read() << 8));
  int16_t y = (int16_t)(Wire.read() | (Wire.read() << 8));
  int16_t z = (int16_t)(Wire.read() | (Wire.read() << 8));
  (void)z;

  if (x == 0 && y == 0) {
    return false;
  }

  float heading = atan2((float)y, (float)x) * 180.0f / PI;
  if (heading < 0.0f) {
    heading += 360.0f;
  }
  outHeadingDeg = heading;
  return true;
}

bool initMagnetometer() {
  if (initHMC5883()) {
    magType = MAG_HMC5883;
    return true;
  }
  if (initQMC5883()) {
    magType = MAG_QMC5883;
    return true;
  }
  magType = MAG_NONE;
  return false;
}

bool readHeading(float& outHeadingDeg) {
  if (magType == MAG_HMC5883) {
    return readHeadingHMC5883(outHeadingDeg);
  }
  if (magType == MAG_QMC5883) {
    return readHeadingQMC5883(outHeadingDeg);
  }
  return false;
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
  if (initMagnetometer()) {
    if (magType == MAG_HMC5883) {
      Serial.println("Magnetometer: HMC5883 initialized on SDA=9, SCL=8");
    } else if (magType == MAG_QMC5883) {
      Serial.println("Magnetometer: QMC5883 initialized on SDA=9, SCL=8");
    }
  } else {
    Serial.println("Warning: magnetometer init failed (HMC/QMC).");
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

  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
  }

  if (millis() - lastHeadingRead >= 100) {
    lastHeadingRead = millis();
    float h = 0.0f;
    headingValid = readHeading(h);
    if (headingValid) {
      headingDeg = h;
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