// Simple and robust WiFi connection for ESP32-S3 SuperMini
#include <WiFi.h>

const char* ssid = "Gringo Burru";
const char* password = "Campina1";

void connectToWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true); // Ensure clean start
  delay(1000);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 30) {
    delay(500);
    Serial.print(".");
    retries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected!");
    Serial.print("IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nFailed to connect to WiFi. Restarting...");
    delay(2000);
    ESP.restart();
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  connectToWiFi();
}

void loop() {
  // Reconnect if WiFi drops
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi lost. Reconnecting...");
    connectToWiFi();
  }
  delay(1000);
}
