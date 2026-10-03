#include <Arduino.h>
void setup() { Serial.begin(115200); pinMode(9, OUTPUT); pinMode(10, INPUT); }
void loop() {
  digitalWrite(9, LOW); delayMicroseconds(2);
  digitalWrite(9, HIGH); delayMicroseconds(10);
  digitalWrite(9, LOW);
  unsigned long d = pulseIn(10, HIGH, 30000UL);
  Serial.print("cm="); Serial.println(d / 58.0, 1);
  delay(200);
}
