// Magnetometer calibration globals
bool calibrating = false;
unsigned long calibrationStart = 0;
float magMin[3] = {10000, 10000, 10000};
float magMax[3] = {-10000, -10000, -10000};
const unsigned long calibrationDuration = 10000;
bool calibrationLoadedFromStorage = false;
float offX = 0.0f;
float offY = 0.0f;
float offZ = 0.0f;

const char* calibrationNs = "magcal";
const char* keyCalValid = "valid";
const char* keyOffX = "offX";
const char* keyOffY = "offY";
const char* keyOffZ = "offZ";

bool loadCalibrationFromStorage();
void saveCalibrationToStorage();

void startCalibration() {
  calibrating = true;
  calibrationStart = millis();
  for (int i = 0; i < 3; ++i) {
    magMin[i] = 10000;
    magMax[i] = -10000;
  }
}

void updateCalibration(const float* xyz) {
  for (int i = 0; i < 3; ++i) {
    if (xyz[i] < magMin[i]) magMin[i] = xyz[i];
    if (xyz[i] > magMax[i]) magMax[i] = xyz[i];
  }
}

void finishCalibration() {
  calibrating = false;
  offX = (magMin[0] + magMax[0]) / 2.0f;
  offY = (magMin[1] + magMax[1]) / 2.0f;
  offZ = (magMin[2] + magMax[2]) / 2.0f;
  saveCalibrationToStorage();
  Serial.println("Magnetometer calibration complete.");
  Serial.print("Min: "); Serial.print(magMin[0]); Serial.print(", "); Serial.print(magMin[1]); Serial.print(", "); Serial.println(magMin[2]);
  Serial.print("Max: "); Serial.print(magMax[0]); Serial.print(", "); Serial.print(magMax[1]); Serial.print(", "); Serial.println(magMax[2]);
  Serial.print("Offsets: "); Serial.print(offX); Serial.print(", "); Serial.print(offY); Serial.print(", "); Serial.println(offZ);
}

#define LED_PIN 21 // Change this if your onboard LED is on a different pin

const int ledPins[] = {7, 13, 12, 11, 10, 9, 8};
const int numLeds = 7;
const int ledPwmFreq = 5000;
const int ledPwmResolution = 8;
const float ledRingAngles[] = {275, 303, 332, 0, 28, 57, 85};

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
#include <Preferences.h>

const char* WIFI_SSID     = "Gringo Burru";
const char* WIFI_PASSWORD = "Campina1";

// ================= GPS (ESP32-S3 SuperMini UART) =================
static const int RX_PIN = 44;
static const int TX_PIN = 43;
static const uint32_t GPS_BAUD = 9600;

// ================= MAGNETOMETER =================
const int SDA_PIN = 2;
const int SCL_PIN = 3;
QMC5883P mag;
Preferences preferences;

TinyGPSPlus gps;
HardwareSerial gpsSerial(1);
WebServer server(80);

// ── Navigation state ──────────────────────────────────────────────────────────
struct NavWaypoint { double lat; double lon; };
const int MAX_NAV_WAYPOINTS = 30;
NavWaypoint navWaypoints[MAX_NAV_WAYPOINTS];
int  navWPCount        = 0;
int  navWPIndex        = 0;
bool navActive         = false;
double navDistM        = 0.0;
double navTargetBear   = 0.0;
int  navBurstRemaining = 0;
unsigned long lastNavLedAt = 0;
bool vibrationEnabled  = true;

// Forward declarations for symbols used before their definitions.
extern bool directionLedsActive;
extern bool headingValid;
extern float headingDeg;
extern unsigned long directionLedsActivatedAt;
void turnOffDirectionLeds();
void updateDirectionLedsMode1(float heading, float target);

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

void handleCalibrate() {
  startCalibration();
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.send(200, "application/json", "{\"status\":\"calibrating\"}");
}

void handleSetWaypoints() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");

  int n = server.arg("n").toInt();
  if (n <= 0) {
    navWPCount = 0;
    navWPIndex = 0;
    navActive  = false;
    turnOffDirectionLeds();
    server.send(200, "application/json", "{\"ok\":true,\"active\":false}");
    return;
  }

  if (n > MAX_NAV_WAYPOINTS) n = MAX_NAV_WAYPOINTS;
  for (int i = 0; i < n; i++) {
    navWaypoints[i].lat = server.arg("lat" + String(i)).toDouble();
    navWaypoints[i].lon = server.arg("lon" + String(i)).toDouble();
  }
  navWPCount        = n;
  navWPIndex        = 0;
  navActive         = true;
  navBurstRemaining = 0;
  lastNavLedAt      = 0;

  server.send(200, "application/json", "{\"ok\":true,\"active\":true}");
}

void handleVibration() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");

  if (server.hasArg("enabled")) {
    vibrationEnabled = (server.arg("enabled") != "0");
    if (!vibrationEnabled) turnOffDirectionLeds();
  }

  server.send(200, "application/json", "{\"ok\":true}");
}

double prevLat = 0, prevLon = 0;
bool hasPrev = false;
double lastDist = 0;
unsigned long lastCalc = 0;
unsigned long lastHeadingRead = 0;

bool headingValid = false;
float headingDeg = 0.0f;
bool magReady = false;

const unsigned long directionLedOnDuration = 300;
bool directionLedsActive = false;
unsigned long directionLedsActivatedAt = 0;
unsigned long activeDirectionLedOnDuration = 300; // overridden to 600 ms for first flash after WP advance
bool navFirstFlashPending = false;
bool wpConfirmFlashActive = false;
int  wpConfirmFlashStep = 0;   // 0-9: even = ON, odd = OFF (5 pulses × 50 ms)
unsigned long wpConfirmFlashAt = 0;

float shortestAngleDifference(float from, float to) {
  float delta = to - from;
  while (delta > 180.0f) delta -= 360.0f;
  while (delta < -180.0f) delta += 360.0f;
  return delta;
}

void setLedBrightnessByIndex(int idx, uint8_t brightness) {
  ledcWrite(ledPins[idx], brightness);
}

void turnOffDirectionLeds() {
  for (int i = 0; i < numLeds; i++) {
    setLedBrightnessByIndex(i, 0);
  }
}

float getMode1BlendRangeDeg(int idx) {
  if (idx <= 0) {
    return fabsf(shortestAngleDifference(ledRingAngles[0], ledRingAngles[1]));
  }

  if (idx >= numLeds - 1) {
    return fabsf(shortestAngleDifference(ledRingAngles[numLeds - 2], ledRingAngles[numLeds - 1]));
  }

  float prevGap = fabsf(shortestAngleDifference(ledRingAngles[idx - 1], ledRingAngles[idx]));
  float nextGap = fabsf(shortestAngleDifference(ledRingAngles[idx], ledRingAngles[idx + 1]));
  return fminf(prevGap, nextGap);
}

float mode1ScaleForCircle(float circleAbsAngle, float target, int idx) {
  float signedDelta = shortestAngleDifference(circleAbsAngle, target);

  // Keep left-most circle active in the same extra range used in Experiment 2.
  if (idx == 0 && signedDelta >= -90.0f && signedDelta <= 0.0f) {
    return 1.0f;
  }

  // Keep right-most circle active in the same extra range used in Experiment 2.
  if (idx == 6 && signedDelta >= 0.0f && signedDelta <= 90.0f) {
    return 1.0f;
  }

  float diff = fabsf(signedDelta);
  if (diff < 5.0f) {
    return 1.0f;
  }

  float blendRange = getMode1BlendRangeDeg(idx);
  if (diff >= blendRange) {
    return 0.0f;
  }

  return 1.0f - diff / blendRange;
}

uint8_t scaleToBrightness(float t) {
  if (t < 0.0f) t = 0.0f;
  if (t > 1.0f) t = 1.0f;

  const float logCurveStrength = 10.444f;
  float curved = log1pf(logCurveStrength * t) / log1pf(logCurveStrength);
  return (uint8_t)(curved * 255.0f);
}

void updateDirectionLedsMode1(float heading, float target) {
  int exclusiveIdx = -1;
  for (int i = 0; i < numLeds; i++) {
    float absAngle = fmodf(ledRingAngles[i] + fmodf(heading, 360.0f) + 360.0f, 360.0f);
    if (fabsf(shortestAngleDifference(absAngle, target)) < 5.0f) {
      exclusiveIdx = i;
      break;
    }
  }

  for (int i = 0; i < numLeds; i++) {
    float scale;
    if (exclusiveIdx != -1) {
      scale = (i == exclusiveIdx) ? 1.0f : 0.0f;
    } else {
      float absAngle = fmodf(ledRingAngles[i] + fmodf(heading, 360.0f) + 360.0f, 360.0f);
      scale = mode1ScaleForCircle(absAngle, target, i);
    }

    setLedBrightnessByIndex(i, scaleToBrightness(scale));
  }
}

void handleDirectionLedsTimeout() {
  if (!directionLedsActive) return;
  if (wpConfirmFlashActive) return;  // confirmation flash takes priority
  if (millis() - directionLedsActivatedAt >= activeDirectionLedOnDuration) {
    turnOffDirectionLeds();
    directionLedsActive = false;
  }
}

void triggerWPConfirmFlash() {
  turnOffDirectionLeds();
  // First pulse — turn on immediately
  setLedBrightnessByIndex(0, 255);
  setLedBrightnessByIndex(3, 255);
  setLedBrightnessByIndex(6, 255);
  wpConfirmFlashActive = true;
  wpConfirmFlashStep   = 0;
  wpConfirmFlashAt     = millis();
  directionLedsActive  = false;
}

void handleWPConfirmFlashTimeout() {
  if (!wpConfirmFlashActive) return;
  if (millis() - wpConfirmFlashAt < 50) return;  // 5 pulses × 50 ms = 500 ms total

  wpConfirmFlashAt = millis();
  wpConfirmFlashStep++;

  if (wpConfirmFlashStep >= 10) {      // 5 on + 5 off phases done
    turnOffDirectionLeds();
    wpConfirmFlashActive = false;
    return;
  }

  if (wpConfirmFlashStep % 2 == 0) {  // even step = ON
    setLedBrightnessByIndex(0, 255);
    setLedBrightnessByIndex(3, 255);
    setLedBrightnessByIndex(6, 255);
  } else {                            // odd step = OFF
    turnOffDirectionLeds();
  }
}

bool calculateHeading(const float* xyz, float& outHeadingDeg) {
  if (calibrating) return false;

  float x = xyz[0] - offX;
  float y = xyz[1] - offY;

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
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.send(204);
}

void handleData() {
  char json[512];
  snprintf(json, sizeof(json),
    "{\"fix\":%s,\"lat\":%.6f,\"lon\":%.6f,\"dist\":%.2f,"
    "\"alt_valid\":%s,\"alt\":%.1f,"
    "\"sats_valid\":%s,\"sats\":%d,"
    "\"spd_valid\":%s,\"spd\":%.2f,"
    "\"heading_valid\":%s,\"heading\":%.1f,"
    "\"nav_active\":%s,\"nav_wp_index\":%d,\"nav_wp_count\":%d,"
    "\"nav_dist\":%.1f,\"nav_bearing\":%.1f}",
    gps.location.isValid() ? "true" : "false",
    gps.location.isValid() ? gps.location.lat() : 0.0,
    gps.location.isValid() ? gps.location.lng() : 0.0,
    lastDist,
    gps.altitude.isValid() ? "true" : "false",
    gps.altitude.isValid() ? gps.altitude.meters() : 0.0,
    gps.satellites.isValid() ? "true" : "false",
    gps.satellites.isValid() ? (int)gps.satellites.value() : 0,
    gps.speed.isValid() ? "true" : "false",
    gps.speed.isValid() ? gps.speed.kmph() : 0.0,
    headingValid ? "true" : "false",
    headingValid ? headingDeg : 0.0,
    navActive ? "true" : "false", navWPIndex, navWPCount,
    (float)navDistM, (float)navTargetBear
  );

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.send(200, "application/json", json);
}

// ── Navigation math & update ─────────────────────────────────────────────────
double navHaversineM(double lat1, double lon1, double lat2, double lon2) {
  const double R = 6371000.0;
  double dLat = (lat2 - lat1) * PI / 180.0;
  double dLon = (lon2 - lon1) * PI / 180.0;
  double a = sin(dLat/2)*sin(dLat/2) +
             cos(lat1*PI/180.0)*cos(lat2*PI/180.0)*sin(dLon/2)*sin(dLon/2);
  return R * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
}

double navCalcBearing(double lat1, double lon1, double lat2, double lon2) {
  double dLon = (lon2 - lon1) * PI / 180.0;
  double y = sin(dLon) * cos(lat2 * PI / 180.0);
  double x = cos(lat1*PI/180.0)*sin(lat2*PI/180.0) -
             sin(lat1*PI/180.0)*cos(lat2*PI/180.0)*cos(dLon);
  double b = atan2(y, x) * 180.0 / PI;
  return fmod(b + 360.0, 360.0);
}

// Called every second — updates distance/bearing and handles auto-advance.
void updateNavState() {
  if (!navActive || navWPCount == 0) return;
  if (!gps.location.isValid()) return;

  double lat = gps.location.lat();
  double lon = gps.location.lng();
  navDistM      = navHaversineM(lat, lon, navWaypoints[navWPIndex].lat, navWaypoints[navWPIndex].lon);
  navTargetBear = navCalcBearing(lat, lon, navWaypoints[navWPIndex].lat, navWaypoints[navWPIndex].lon);

  // Auto-advance when within 10 m of current waypoint
  if (navDistM <= 10.0 && navWPIndex < navWPCount - 1) {
    triggerWPConfirmFlash();
    navWPIndex++;
    navBurstRemaining = 0;
    navFirstFlashPending = true;
    lastNavLedAt = 0;
    navDistM      = navHaversineM(lat, lon, navWaypoints[navWPIndex].lat, navWaypoints[navWPIndex].lon);
    navTargetBear = navCalcBearing(lat, lon, navWaypoints[navWPIndex].lat, navWaypoints[navWPIndex].lon);
    Serial.printf("Nav: advanced to WP %d, dist=%.1f\n", navWPIndex, navDistM);
  } else if (navDistM <= 10.0 && navWPIndex == navWPCount - 1) {
    // Last waypoint reached — stop navigation
    triggerWPConfirmFlash();
    navActive = false;
    navBurstRemaining = 0;
    Serial.println("Nav: last waypoint reached, navigation stopped");
  }
}

// Called every loop iteration — fires LEDs at the distance-based interval.
void updateNavLeds() {
  if (!navActive || navWPCount == 0 || !headingValid || !vibrationEnabled) return;
  if (wpConfirmFlashActive) return;  // confirmation flash takes priority

  unsigned long interval;
  if (navBurstRemaining > 0) {
    interval = 1000;
  } else if (navDistM > 50.0) {
    interval = 5000;
  } else if (navDistM <= 10.0) {
    interval = 1000;
  } else {
    // Linear: 5000 ms at 50 m -> 1000 ms at 10 m
    interval = (unsigned long)(5000.0 - ((50.0 - navDistM) / 40.0) * 4000.0);
  }

  unsigned long now = millis();
  if (now - lastNavLedAt >= interval) {
    lastNavLedAt = now;
    if (navBurstRemaining > 0) navBurstRemaining--;
    activeDirectionLedOnDuration = navFirstFlashPending ? 600UL : directionLedOnDuration;
    navFirstFlashPending = false;
    updateDirectionLedsMode1(headingDeg, (float)navTargetBear);
    directionLedsActive = true;
    directionLedsActivatedAt = now;
    Serial.printf("NavLED: wp=%d dist=%.1f bearing=%.1f interval=%lums\n",
                  navWPIndex, navDistM, navTargetBear, interval);
  }
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  setLedColor(WIFI_LED_CONNECTING, false);

  for (int i = 0; i < numLeds; i++) {
    ledcAttach(ledPins[i], ledPwmFreq, ledPwmResolution);
    setLedBrightnessByIndex(i, 0);
  }

  Serial.begin(115200);
  delay(100);

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);

  magReady = mag.begin();
  if (magReady) {
    Serial.println("Magnetometer initialized (QMC5883P) on SDA=2, SCL=3");
    calibrationLoadedFromStorage = loadCalibrationFromStorage();
    if (calibrationLoadedFromStorage) {
      calibrating = false;
      Serial.printf("Loaded calibration offsets: X=%.2f, Y=%.2f, Z=%.2f\n", offX, offY, offZ);
    } else {
      startCalibration();
      Serial.println("No saved calibration found, starting 10s calibration. Rotate sensor in all directions.");
    }
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

    if (millis() - connectStart > 15000) {
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

  server.on("/", HTTP_GET, handleRoot);
  server.on("/data", HTTP_GET, handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.on("/calibrate", HTTP_GET, handleCalibrate);
  server.on("/waypoints", HTTP_GET, handleSetWaypoints);
  server.on("/vibration", HTTP_GET, handleVibration);
  server.begin();
  Serial.println("Ready.");

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, RX_PIN, TX_PIN);
  Serial.println("GPS UART initialized on RX=44, TX=43");
}

void loop() {
  static unsigned long lastBlink = 0;
  static bool blinkState = false;
  static float lastMagXYZ[3] = {0, 0, 0};
  bool magReadSuccess = false;

  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastBlink > 500) {
      blinkState = !blinkState;
      setLedColor(WIFI_LED_CONNECTING, blinkState);
      lastBlink = millis();
    }
    turnOffDirectionLeds();
    directionLedsActive = false;
    delay(10);
    return;
  } else {
    setLedColor(WIFI_LED_CONNECTED);
  }

  server.handleClient();
  handleDirectionLedsTimeout();
  handleWPConfirmFlashTimeout();
  updateNavLeds();

  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
  }

  if (millis() - lastHeadingRead >= 500) {
    lastHeadingRead = millis();

    if (magReady) {
      magReadSuccess = mag.readXYZ(lastMagXYZ);
      if (magReadSuccess) {
        if (calibrating) {
          updateCalibration(lastMagXYZ);
          if (millis() - calibrationStart >= calibrationDuration) {
            finishCalibration();
          }
        }

        float h = 0.0f;
        headingValid = calculateHeading(lastMagXYZ, h);
        if (headingValid) headingDeg = h;

        Serial.print("Heading: ");
        Serial.println(headingDeg);
      } else {
        headingValid = false;
      }
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
    updateNavState();
  }
}
