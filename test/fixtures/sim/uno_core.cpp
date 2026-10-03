#include <Arduino.h>
volatile unsigned int hits = 0;
void onFall() { hits++; }
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
  pinMode(2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(2), onFall, FALLING);
  analogWrite(9, 128);
  Serial.println("Hello from Uno");
}
void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
  Serial.print("t=");
  Serial.print(millis());
  Serial.print(" a0=");
  Serial.print(analogRead(A0));
  Serial.print(" d7=");
  Serial.print(digitalRead(7));
  Serial.print(" hits=");
  Serial.println(hits);
}
