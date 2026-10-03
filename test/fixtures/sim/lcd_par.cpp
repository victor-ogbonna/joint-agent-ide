#include <Arduino.h>
#include <LiquidCrystal.h>
LiquidCrystal lcd(12, 11, 5, 4, 3, 2);
void setup() {
  lcd.begin(16, 2);
  lcd.print("hello, world!");
  lcd.setCursor(3, 1);
  lcd.print(1234);
  lcd.blink();
}
void loop() {}
