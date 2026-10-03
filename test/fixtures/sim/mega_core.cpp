#include <Arduino.h>
volatile unsigned int hits = 0;
void onFall() { hits++; }
void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);
  pinMode(13, OUTPUT);
  pinMode(18, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(18), onFall, FALLING);
  analogWrite(44, 64);
  Serial.println("Hello from Mega");
  Serial1.println("one");
}
void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
  Serial.print("t=");
  Serial.print(millis());
  Serial.print(" a8=");
  Serial.print(analogRead(A8));
  Serial.print(" d30=");
  Serial.print(digitalRead(30));
  Serial.print(" hits=");
  Serial.println(hits);
}
