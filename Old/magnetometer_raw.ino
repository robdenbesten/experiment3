#include <Wire.h>
#include <qmc5883p.h>
#include <math.h>

const int I2C_SDA_PIN = 9;
const int I2C_SCL_PIN = 8;
QMC5883P mag;

float magMin[3] = {10000, 10000, 10000};
float magMax[3] = {-10000, -10000, -10000};

void calibrateMagnetometer() {
  Serial.println("Rotate the sensor in all directions for 5 seconds to calibrate...");
  unsigned long start = millis();
  while (millis() - start < 5000) {
    float xyz[3];
    if (mag.readXYZ(xyz)) {
      for (int i = 0; i < 3; ++i) {
        if (xyz[i] < magMin[i]) magMin[i] = xyz[i];
        if (xyz[i] > magMax[i]) magMax[i] = xyz[i];
      }
    }
    delay(20);
  }
  Serial.print("Calibration done. Min: ");
  Serial.print(magMin[0]); Serial.print(", "); Serial.print(magMin[1]); Serial.print(", "); Serial.println(magMin[2]);
  Serial.print("Max: ");
  Serial.print(magMax[0]); Serial.print(", "); Serial.print(magMax[1]); Serial.print(", "); Serial.println(magMax[2]);
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(100000);
  if (mag.begin()) {
    Serial.println("QMC5883P initialized on SDA=9, SCL=8");
    calibrateMagnetometer();
  } else {
    Serial.println("QMC5883P init failed!");
    while (1) delay(1000);
  }
}

void loop() {
  float xyz[3];
  if (mag.readXYZ(xyz)) {
    // Apply calibration (offset and scale)
    float x = (xyz[0] - (magMin[0] + magMax[0]) / 2.0f) / ((magMax[0] - magMin[0]) / 2.0f);
    float y = (xyz[1] - (magMin[1] + magMax[1]) / 2.0f) / ((magMax[1] - magMin[1]) / 2.0f);
    float heading = atan2(y, x) * 180.0f / PI;
    if (heading < 0.0f) heading += 360.0f;
    Serial.print("Heading: "); Serial.print(heading, 1); Serial.print(" deg");
    Serial.print(" | Raw X: "); Serial.print(xyz[0]);
    Serial.print(", Y: "); Serial.print(xyz[1]);
    Serial.print(", Z: "); Serial.println(xyz[2]);
  } else {
    Serial.println("Read failed");
  }
  delay(200);
}
