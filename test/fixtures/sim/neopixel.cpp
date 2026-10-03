#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel ring(16, 5, NEO_GRB + NEO_KHZ800);
Adafruit_NeoPixel chain(3, 6, NEO_GRB + NEO_KHZ800);
void setup() {
  ring.begin();
  ring.setPixelColor(0, ring.Color(255, 0, 0));
  ring.setPixelColor(1, ring.Color(0, 255, 0));
  ring.setPixelColor(15, ring.Color(0, 0, 255));
  ring.show();
  chain.begin();
  chain.setPixelColor(0, chain.Color(10, 20, 30));
  chain.setPixelColor(1, chain.Color(40, 50, 60));
  chain.setPixelColor(2, chain.Color(70, 80, 90));
  chain.show();
}
void loop() {}
