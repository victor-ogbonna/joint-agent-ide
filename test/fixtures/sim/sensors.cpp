#include <Arduino.h>
volatile int enc = 0;
void onClk() { if (digitalRead(3) == HIGH) enc++; else enc--; }
void setup() {
  Serial.begin(115200);
  pinMode(7, INPUT); pinMode(6, INPUT_PULLUP); pinMode(5, INPUT); pinMode(4, INPUT_PULLUP);
  pinMode(2, INPUT); pinMode(3, INPUT);
  attachInterrupt(digitalPinToInterrupt(2), onClk, FALLING);
}
void loop() {
  int a0 = analogRead(A0);
  float v = a0 / 1024. * 5;
  float r = 2000 * v / (1 - v / 5);
  float lux = pow(50 * 1e3 * pow(10, 0.7) / r, (1 / 0.7));
  int a1 = analogRead(A1);
  float celsius = 1 / (log(1 / (1023. / a1 - 1)) / 3950 + 1.0 / 298.15) - 273.15;
  Serial.print("lux="); Serial.print(lux, 0);
  Serial.print(" temp="); Serial.print(celsius, 1);
  Serial.print(" x="); Serial.print(analogRead(A2));
  Serial.print(" y="); Serial.print(analogRead(A3));
  Serial.print(" pir="); Serial.print(digitalRead(7));
  Serial.print(" sel="); Serial.print(digitalRead(6));
  Serial.print(" do="); Serial.print(digitalRead(5));
  Serial.print(" enc="); Serial.print(enc);
  Serial.print(" sw="); Serial.println(digitalRead(4));
  delay(100);
}
