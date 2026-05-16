#include <WiFi.h>

const char* WIFI_SSID     = "Odido-51E239";
const char* WIFI_PASSWORD = "SYRHM8S8JLGFBBR4";

static const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;
static const unsigned long WIFI_RETRY_INTERVAL_MS  = 15000;

unsigned long lastWifiRetry = 0;

const char* wifiStatusText(wl_status_t status) {
  switch (status) {
    case WL_IDLE_STATUS:     return "idle";
    case WL_NO_SSID_AVAIL:   return "ssid not available";
    case WL_SCAN_COMPLETED:  return "scan completed";
    case WL_CONNECTED:       return "connected";
    case WL_CONNECT_FAILED:  return "connect failed";
    case WL_CONNECTION_LOST: return "connection lost";
    case WL_DISCONNECTED:    return "disconnected";
    default:                 return "unknown";
  }
}

void printVisibleNetworks() {
  Serial.println("Visible WiFi networks:");
  int count = WiFi.scanNetworks(false, true);
  if (count <= 0) {
    Serial.println("  none found");
    return;
  }
  for (int i = 0; i < count; i++) {
    Serial.print("  ");
    Serial.print(i + 1);
    Serial.print(": ");
    Serial.print(WiFi.SSID(i));
    Serial.print(" | RSSI ");
    Serial.print(WiFi.RSSI(i));
    Serial.print(" dBm | channel ");
    Serial.println(WiFi.channel(i));
  }
}

bool connectWifiWithTimeout() {
  WiFi.disconnect(false, false);
  delay(150);

  Serial.print("Attempting to connect to: ");
  Serial.println(WIFI_SSID);
  Serial.print("SSID length: ");
  Serial.println(strlen(WIFI_SSID));
  Serial.print("Password length: ");
  Serial.println(strlen(WIFI_PASSWORD));

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < WIFI_CONNECT_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected. IP address: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.print("WiFi connect timeout. Status: ");
  Serial.println(wifiStatusText(WiFi.status()));
  printVisibleNetworks();
  Serial.println("If target SSID is visible here, failure is likely auth/policy (password, WPA mode, max clients).");
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(100);

  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  delay(100);

  connectWifiWithTimeout();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiRetry > WIFI_RETRY_INTERVAL_MS) {
      lastWifiRetry = millis();
      Serial.print("WiFi lost, retrying. Current status: ");
      Serial.println(wifiStatusText(WiFi.status()));
      connectWifiWithTimeout();
    }
  }
  delay(100);
}
