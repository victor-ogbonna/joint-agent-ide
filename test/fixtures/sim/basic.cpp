#include <Arduino.h>
#include <Servo.h>
Servo servo;
int lastA = -1, lastB = -1, lastPot = -100;
void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT_PULLUP);  // button to GND
  pinMode(4, INPUT);         // button to 5V, 10k pull-down
  pinMode(8, OUTPUT);        // LED through 220R
  servo.attach(9);
  Serial.println("ready");
}
void loop() {
  int a = digitalRead(2), b = digitalRead(4);
  digitalWrite(8, a == LOW ? HIGH : LOW);
  if (a != lastA) { Serial.print("btnA="); Serial.println(a); lastA = a; }
  if (b != lastB) { Serial.print("btnB="); Serial.println(b); lastB = b; }
  int pot = analogRead(A0);
  if (abs(pot - lastPot) > 3) { Serial.print("pot="); Serial.println(pot); lastPot = pot; servo.write(map(pot, 0, 1023, 0, 180)); }
  if (Serial.available()) {
    String s = Serial.readStringUntil('\n');
    Serial.print("echo:"); Serial.println(s);
    if (s == "tone") tone(7, 440);
    if (s == "notone") noTone(7);
  }
  delay(10);
}
