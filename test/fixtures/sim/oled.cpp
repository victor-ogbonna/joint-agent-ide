#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);
void setup() {
  Serial.begin(115200);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { Serial.println("oled fail"); for (;;); }
  display.clearDisplay();
  display.fillRect(10, 20, 30, 15, SSD1306_WHITE);
  display.drawPixel(0, 0, SSD1306_WHITE);
  display.drawPixel(127, 63, SSD1306_WHITE);
  display.display();
  Serial.println("oled ok");
}
void loop() {}
