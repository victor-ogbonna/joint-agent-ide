#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_NeoPixel.h>
LiquidCrystal_I2C lcd(0x27, 20, 4);
Adafruit_NeoPixel matrix(64, 6, NEO_GRB + NEO_KHZ800);
void setup() {
  Serial.begin(9600);
  pinMode(22, INPUT_PULLUP);
  lcd.init(); lcd.backlight();
  lcd.setCursor(0, 0); lcd.print("Row zero");
  lcd.setCursor(0, 1); lcd.print("Row one");
  lcd.setCursor(0, 2); lcd.print("Row two");
  lcd.setCursor(0, 3); lcd.print("Row three");
  matrix.begin();
  matrix.setPixelColor(0, matrix.Color(255, 0, 0));
  matrix.setPixelColor(63, matrix.Color(0, 0, 255));
  matrix.show();
  Serial.println("mega ready");
}
int last = -1;
void loop() {
  int b = digitalRead(22);
  if (b != last) { Serial.print("b22="); Serial.print(b); Serial.print(" a8="); Serial.println(analogRead(A8)); last = b; }
  delay(20);
}
