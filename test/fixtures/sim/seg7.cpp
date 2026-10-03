#include <Arduino.h>
// Single digit, common anode: segments A-G on pins 2-8 (LOW lights a segment).
// Four digits, common cathode: segments A-G on A0-A5 + 13, digits on 9-12 (LOW selects a digit).
const byte one[7] = {0, 1, 1, 0, 0, 0, 0};
const byte digits[4][7] = {{0,1,1,0,0,0,0},{1,1,0,1,1,0,1},{1,1,1,1,0,0,1},{0,1,1,0,0,1,1}};
const byte segPins4[7] = {A0, A1, A2, A3, A4, A5, 13};
void setup() {
  for (int i = 0; i < 7; i++) { pinMode(2 + i, OUTPUT); digitalWrite(2 + i, one[i] ? LOW : HIGH); }
  for (int i = 0; i < 7; i++) pinMode(segPins4[i], OUTPUT);
  for (int d = 0; d < 4; d++) { pinMode(9 + d, OUTPUT); digitalWrite(9 + d, HIGH); }
}
void loop() {
  for (int d = 0; d < 4; d++) {
    for (int i = 0; i < 7; i++) digitalWrite(segPins4[i], digits[d][i] ? HIGH : LOW);
    digitalWrite(9 + d, LOW);
    delay(3);
    digitalWrite(9 + d, HIGH);
  }
}
