#include <HardwareSerial.h>
#include <TinyGPSPlus.h>
#include <WiFi.h>
#include <WebServer.h>

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

TinyGPSPlus gps;
HardwareSerial gpsSerial(1);
WebServer server(80);

double prevLat = 0, prevLon = 0;
bool   hasPrev = false;
double lastDist = 0;
unsigned long lastCalc = 0;

// Minimal bootstrap page — CSS and JS are loaded from GitHub Pages (HTTPS is
// fine for an HTTP page). app.js uses window.location.hostname to reach back
// to this ESP32, so no IP needs to be hardcoded anywhere.
const char ROOT_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPS Tracker</title>
</head>
<body>
  <div id="app"><p style="font-family:sans-serif;color:#eee;background:#1a1a2e;margin:0;padding:16px">Laden...</p></div>
  <script>
  (function () {
    var BASE = 'https://robdenbesten.github.io/experiment3/';

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

    // Run from cache immediately (instant load)
    var cachedCSS = localStorage.getItem('gps_css');
    var cachedJS  = localStorage.getItem('gps_js');
    if (cachedCSS) injectCSS(cachedCSS);
    if (cachedJS)  injectJS(cachedJS);

    // Fetch updates in background — silent if no internet
    fetch(BASE + 'style.css?' + Date.now())
      .then(function (r) { return r.text(); })
      .then(function (t) { localStorage.setItem('gps_css', t); if (!cachedCSS) injectCSS(t); })
      .catch(function () {});
    fetch(BASE + 'app.js?' + Date.now())
      .then(function (r) { return r.text(); })
      .then(function (t) { localStorage.setItem('gps_js', t);  if (!cachedJS)  injectJS(t);  })
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
  char json[256];
  snprintf(json, sizeof(json),
    "{\"fix\":%s,\"lat\":%.6f,\"lon\":%.6f,\"dist\":%.2f,"
    "\"alt_valid\":%s,\"alt\":%.1f,"
    "\"sats_valid\":%s,\"sats\":%d,"
    "\"spd_valid\":%s,\"spd\":%.2f}",
    gps.location.isValid()   ? "true" : "false",
    gps.location.isValid()   ? gps.location.lat()         : 0.0,
    gps.location.isValid()   ? gps.location.lng()         : 0.0,
    lastDist,
    gps.altitude.isValid()   ? "true" : "false",
    gps.altitude.isValid()   ? gps.altitude.meters()      : 0.0,
    gps.satellites.isValid() ? "true" : "false",
    gps.satellites.isValid() ? (int)gps.satellites.value(): 0,
    gps.speed.isValid()      ? "true" : "false",
    gps.speed.isValid()      ? gps.speed.kmph()           : 0.0
  );
  server.sendHeader("Access-Control-Allow-Origin",          "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.send(200, "application/json", json);
}

void setup() {
  Serial.begin(115200);
  delay(100);

  // ── WiFi first, nothing else ──────────────────────────────────────────────
  WiFi.persistent(false);   // don't read/write flash; prevents state corruption
  WiFi.setAutoReconnect(true);
  WiFi.mode(WIFI_STA);
  delay(100);               // let radio settle after mode switch

  if (!WiFi.config(FIXED_IP, FIXED_GATEWAY, FIXED_SUBNET)) {
    Serial.println("Waarschuwing: vaste IP-configuratie mislukt.");
  }

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Verbinden");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.print("\nIP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Open op telefoon: http://");
  Serial.println(WiFi.localIP());

  server.on("/",     HTTP_GET,     handleRoot);
  server.on("/data", HTTP_GET,     handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.begin();
  Serial.println("Klaar.");

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