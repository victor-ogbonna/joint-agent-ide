/**
 * Ready-made projects for the simulator: a sketch and its circuit.
 */
import type { Diagram, DiagramConnection, DiagramPart } from "./diagram";

export interface Example {
  id: string;
  name: string;
  description: string;
  code: string;
  diagram: Diagram;
}

const p = (id: string, type: string, left: number, top: number, attrs: Record<string, string> = {}, rotate = 0): DiagramPart => ({ id, type, left, top, rotate, attrs });
const w = (a: string, b: string, color = "green", route: string[] = []): DiagramConnection => [a, b, color, route];
const d = (parts: DiagramPart[], connections: DiagramConnection[]): Diagram => ({ version: 1, author: "Joint-Agent", editor: "joint-agent", parts, connections });
const uno = (left = 0, top = 220) => p("uno", "wokwi-arduino-uno", left, top);

export const EXAMPLES: Example[] = [
  {
    id: "blink",
    name: "Blink",
    description: "An LED on pin 13 turns on and off every half second.",
    code: `// Blink: the LED on pin 13 turns on and off every half second.

void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}
`,
    diagram: d(
      [uno(), p("led1", "wokwi-led", 100, 80, { color: "red" }), p("r1", "wokwi-resistor", 95.5, 165, { value: "220" }, 90)],
      [w("uno:13", "r1:2", "green"), w("r1:1", "led1:A", "green"), w("led1:C", "uno:GND.1", "black")],
    ),
  },
  {
    id: "button",
    name: "Button and LED",
    description: "Press the button to light the LED; the program prints each press.",
    code: `// Press the button to light the LED.
// The button joins pin 2 to GND; INPUT_PULLUP keeps the pin HIGH otherwise.

const int BUTTON = 2;
const int LED = 8;
bool wasPressed = false;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  Serial.println("Press the button");
}

void loop() {
  bool pressed = digitalRead(BUTTON) == LOW;
  digitalWrite(LED, pressed ? HIGH : LOW);
  if (pressed != wasPressed) {
    Serial.println(pressed ? "Pressed" : "Released");
    wasPressed = pressed;
  }
  delay(10);
}
`,
    diagram: d(
      [uno(), p("led1", "wokwi-led", 148, 80, { color: "yellow" }), p("r1", "wokwi-resistor", 143.5, 165, { value: "220" }, 90), p("btn1", "wokwi-pushbutton", 300, 150, { color: "green", key: "b" })],
      [
        w("uno:8", "r1:2", "orange"), w("r1:1", "led1:A", "orange"), w("led1:C", "uno:GND.1", "black", ["v12"]),
        w("uno:2", "btn1:2.l", "green", ["v-20"]), w("btn1:1.r", "uno:GND.3", "black", ["h15", "v270"]),
      ],
    ),
  },
  {
    id: "servo",
    name: "Potentiometer and servo",
    description: "Turn the knob to move the servo; the program prints the reading.",
    code: `#include <Servo.h>

// Turn the potentiometer to move the servo.
Servo servo;

void setup() {
  servo.attach(9);
  Serial.begin(9600);
}

void loop() {
  int value = analogRead(A0);
  int angle = map(value, 0, 1023, 0, 180);
  servo.write(angle);
  Serial.print("Potentiometer: ");
  Serial.print(value);
  Serial.print("  Angle: ");
  Serial.println(angle);
  delay(200);
}
`,
    diagram: d(
      [uno(), p("servo1", "wokwi-servo", -210, 260, { horn: "double" }, 180), p("pot1", "wokwi-potentiometer", 230, 450, { value: "512" }, 180)],
      [
        w("servo1:PWM", "uno:9", "orange", ["h20", "*", "v20"]), w("servo1:V+", "uno:5V", "red", ["h12", "*", "v-15"]), w("servo1:GND", "uno:GND.2", "black", ["h4", "*", "v-25"]),
        w("uno:5V", "pot1:VCC", "red", ["v35"]), w("uno:GND.3", "pot1:GND", "black", ["v25"]), w("uno:A0", "pot1:SIG", "green", ["v15"]),
      ],
    ),
  },
  {
    id: "lcd",
    name: "LCD 16×2 (I2C)",
    description: "Text and a running clock on a character display over I2C.",
    code: `#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello, world!");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("Uptime: ");
  lcd.print(millis() / 1000);
  lcd.print(" s");
  delay(250);
}
`,
    diagram: d(
      [uno(), p("lcd1", "wokwi-lcd1602", 60, 30, { pins: "i2c" })],
      [
        w("lcd1:GND", "uno:GND.1", "black", ["h-12", "*", "v12"]), w("lcd1:SDA", "uno:A4.2", "green", ["h-28", "*", "v20"]),
        w("lcd1:SCL", "uno:A5.2", "blue", ["h-20", "*", "v28"]), w("lcd1:VCC", "uno:5V", "red", ["h-44", "*", "v-20"]),
      ],
    ),
  },
  {
    id: "oled",
    name: "OLED graphics",
    description: "A bouncing ball on an SSD1306 OLED, drawn with Adafruit GFX.",
    code: `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int x = 20, y = 30, dx = 2, dy = 1;

void setup() {
  Serial.begin(9600);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found");
    for (;;);
  }
}

void loop() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(4, 2);
  display.print("Joint-Agent OLED");
  display.drawRect(0, 12, 128, 52, SSD1306_WHITE);
  display.fillCircle(x, y, 4, SSD1306_WHITE);
  display.display();
  x += dx;
  y += dy;
  if (x < 6 || x > 121) dx = -dx;
  if (y < 18 || y > 57) dy = -dy;
  delay(20);
}
`,
    diagram: d(
      [uno(), p("oled1", "wokwi-ssd1306", 60, 40)],
      [
        w("oled1:DATA", "uno:A4.2", "green", ["v-16", "h-50", "*", "v28"]), w("oled1:CLK", "uno:A5.2", "blue", ["v-24", "h-67", "*", "v20"]),
        w("oled1:GND", "uno:GND.1", "black", ["v-16", "h60", "*", "v20"]), w("oled1:VIN", "uno:5V", "red", ["v-24", "h130", "*", "v-20"]),
      ],
    ),
  },
  {
    id: "neopixel",
    name: "NeoPixel ring",
    description: "A rainbow turning around a ring of 16 WS2812 LEDs (Adafruit NeoPixel).",
    code: `#include <Adafruit_NeoPixel.h>

#define PIN 6
#define COUNT 16

Adafruit_NeoPixel ring(COUNT, PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  ring.begin();
  ring.setBrightness(120);
}

void loop() {
  static uint16_t hue = 0;
  for (int i = 0; i < COUNT; i++) {
    ring.setPixelColor(i, ring.gamma32(ring.ColorHSV(hue + i * 65536L / COUNT)));
  }
  ring.show();
  hue += 512;
  delay(20);
}
`,
    diagram: d(
      [uno(), p("ring1", "wokwi-led-ring", 150, 30, { pixels: "16" })],
      [
        w("ring1:DIN", "uno:6", "green", ["v14"]), w("ring1:GND", "uno:GND.1", "black", ["v6"]),
        w("ring1:VCC", "uno:5V", "red", ["v10", "h-231", "*", "v-20"]),
      ],
    ),
  },
  {
    id: "dht22",
    name: "DHT22 thermometer",
    description: "Reads temperature and humidity. Click the sensor while running to change them.",
    code: `#include <DHT.h>

// Click the sensor while the simulation runs to change its readings.
DHT dht(2, DHT22);

void setup() {
  Serial.begin(9600);
  dht.begin();
}

void loop() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("Failed to read from the DHT22");
  } else {
    Serial.print("Temperature: ");
    Serial.print(t, 1);
    Serial.print(" °C   Humidity: ");
    Serial.print(h, 1);
    Serial.println(" %");
  }
  delay(2000);
}
`,
    diagram: d(
      [uno(), p("dht1", "wokwi-dht22", 200, 60)],
      [
        w("dht1:SDA", "uno:2", "green", ["v20"]), w("dht1:VCC", "uno:5V", "red", ["v12", "h-230", "*", "v-20"]),
        w("dht1:GND", "uno:GND.2", "black", ["v8", "h46", "*", "v-30"]),
      ],
    ),
  },
  {
    id: "ultrasonic",
    name: "Distance sensor (HC-SR04)",
    description: "Measures distance with pulseIn(). Click the sensor while running to move the object.",
    code: `// Click the sensor while the simulation runs to change the distance.
const int TRIG = 3;
const int ECHO = 2;

void setup() {
  Serial.begin(9600);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
}

void loop() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long duration = pulseIn(ECHO, HIGH);
  Serial.print("Distance: ");
  Serial.print(duration / 58.0, 1);
  Serial.println(" cm");
  delay(500);
}
`,
    diagram: d(
      [uno(), p("sonar1", "wokwi-hc-sr04", 130, 80, { distance: "100" })],
      [
        w("sonar1:TRIG", "uno:3", "orange", ["v16"]), w("sonar1:ECHO", "uno:2", "green", ["v8"]),
        w("sonar1:GND", "uno:GND.2", "black", ["v4", "h60", "*", "v-30"]), w("sonar1:VCC", "uno:5V", "red", ["v24", "h-216", "*", "v-20"]),
      ],
    ),
  },
  {
    id: "keypad",
    name: "Keypad",
    description: "Prints each key pressed on a 4×4 membrane keypad (Keypad library).",
    code: `#include <Keypad.h>

const byte ROWS = 4;
const byte COLS = 4;
char keys[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'},
};
byte rowPins[ROWS] = {9, 8, 7, 6};
byte colPins[COLS] = {5, 4, 3, 2};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

void setup() {
  Serial.begin(9600);
  Serial.println("Press a key");
}

void loop() {
  char key = keypad.getKey();
  if (key) {
    Serial.print("Key: ");
    Serial.println(key);
  }
}
`,
    diagram: d(
      [p("uno", "wokwi-arduino-uno", 0, 400), p("keypad1", "wokwi-membrane-keypad", 40, 0)],
      [
        w("keypad1:R1", "uno:9", "orange", ["v52"]), w("keypad1:R2", "uno:8", "orange", ["v46"]), w("keypad1:R3", "uno:7", "orange", ["v40"]), w("keypad1:R4", "uno:6", "orange", ["v34"]),
        w("keypad1:C1", "uno:5", "purple", ["v28"]), w("keypad1:C2", "uno:4", "purple", ["v22"]), w("keypad1:C3", "uno:3", "purple", ["v16"]), w("keypad1:C4", "uno:2", "purple", ["v10"]),
      ],
    ),
  },
  {
    id: "melody",
    name: "Buzzer melody",
    description: "Press the button to play a scale on the buzzer with tone().",
    code: `// Press the button to play a scale on the buzzer.
const int BUZZER = 8;
const int BUTTON = 2;
const int NOTES[] = {262, 294, 330, 349, 392, 440, 494, 523};

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
}

void loop() {
  if (digitalRead(BUTTON) == LOW) {
    for (int i = 0; i < 8; i++) {
      tone(BUZZER, NOTES[i], 200);
      delay(250);
    }
  }
}
`,
    diagram: d(
      [uno(), p("bz1", "wokwi-buzzer", 150, 90), p("btn1", "wokwi-pushbutton", 300, 150, { color: "blue", key: "p" })],
      [
        w("bz1:2", "uno:8", "green", ["v20"]), w("bz1:1", "uno:GND.1", "black", ["v10"]),
        w("uno:2", "btn1:2.l", "blue", ["v-20"]), w("btn1:1.r", "uno:GND.3", "black", ["h15", "v270"]),
      ],
    ),
  },
  {
    id: "traffic",
    name: "Traffic light",
    description: "Green, yellow and red LEDs in turn.",
    code: `const int RED = 12;
const int YELLOW = 11;
const int GREEN = 10;

void setup() {
  pinMode(RED, OUTPUT);
  pinMode(YELLOW, OUTPUT);
  pinMode(GREEN, OUTPUT);
}

void loop() {
  digitalWrite(GREEN, HIGH);
  delay(3000);
  digitalWrite(GREEN, LOW);
  digitalWrite(YELLOW, HIGH);
  delay(1000);
  digitalWrite(YELLOW, LOW);
  digitalWrite(RED, HIGH);
  delay(3000);
  digitalWrite(RED, LOW);
}
`,
    diagram: d(
      [
        uno(),
        p("red", "wokwi-led", 90, 60, { color: "red" }), p("yellow", "wokwi-led", 135, 60, { color: "yellow" }), p("green", "wokwi-led", 180, 60, { color: "green" }),
        p("r1", "wokwi-resistor", 85.5, 148.9, { value: "220" }, 90), p("r2", "wokwi-resistor", 130.5, 148.9, { value: "220" }, 90), p("r3", "wokwi-resistor", 175.5, 148.9, { value: "220" }, 90),
      ],
      [
        w("red:A", "r1:1", "red"), w("yellow:A", "r2:1", "yellow"), w("green:A", "r3:1", "green"),
        w("r1:2", "uno:12", "red", ["v12"]), w("r2:2", "uno:11", "yellow", ["v12"]), w("r3:2", "uno:10", "green", ["v20"]),
        w("red:C", "uno:GND.1", "black", ["v100"]), w("yellow:C", "red:C", "black", ["v6"]), w("green:C", "yellow:C", "black", ["v6"]),
      ],
    ),
  },
  {
    id: "sevseg",
    name: "7-segment counter",
    description: "Counts 0 to 9 on a common-cathode 7-segment display.",
    code: `// Counts 0-9 on a common-cathode display: HIGH lights a segment.
const byte PINS[7] = {2, 3, 4, 5, 6, 7, 8};  // A B C D E F G
const byte DIGITS[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};

void setup() {
  for (byte i = 0; i < 7; i++) pinMode(PINS[i], OUTPUT);
}

void loop() {
  for (byte n = 0; n < 10; n++) {
    for (byte i = 0; i < 7; i++) {
      digitalWrite(PINS[i], (DIGITS[n] >> i) & 1 ? HIGH : LOW);
    }
    delay(1000);
  }
}
`,
    diagram: d(
      [uno(), p("sevseg1", "wokwi-7segment", 190, 80, { digits: "1", common: "cathode", color: "red" })],
      [
        w("sevseg1:E", "uno:6", "green", ["v24"]), w("sevseg1:D", "uno:5", "green", ["v32"]), w("sevseg1:C", "uno:4", "green", ["v24"]),
        w("sevseg1:G", "uno:8", "green", ["v-12", "h-34", "*", "v12"]), w("sevseg1:F", "uno:7", "green", ["v-20", "h-51", "*", "v20"]),
        w("sevseg1:A", "uno:2", "green", ["v-20", "h45", "*", "v20"]), w("sevseg1:B", "uno:3", "green", ["v-12", "h23", "*", "v12"]),
        w("sevseg1:COM.2", "uno:GND.1", "black", ["v-28", "h-70", "*", "v6"]),
      ],
    ),
  },
  {
    id: "mega",
    name: "Mega: joystick and 20×4 LCD",
    description: "An Arduino Mega reads a joystick and shows it on a 20×4 display.",
    code: `#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 20, 4);

void setup() {
  pinMode(23, INPUT_PULLUP);
  lcd.init();
  lcd.backlight();
  lcd.print("Arduino Mega 2560");
}

void loop() {
  char line[21];
  snprintf(line, sizeof line, "X: %4d   Y: %4d", analogRead(A0), analogRead(A1));
  lcd.setCursor(0, 2);
  lcd.print(line);
  lcd.setCursor(0, 3);
  lcd.print(digitalRead(23) == LOW ? "Button: pressed " : "Button: released");
  delay(100);
}
`,
    diagram: d(
      [p("mega", "wokwi-arduino-mega", 0, 230), p("lcd1", "wokwi-lcd2004", 20, 10, { pins: "i2c" }), p("joystick1", "wokwi-analog-joystick", 420, 256)],
      [
        w("lcd1:GND", "mega:GND.1", "black", ["h-28", "*", "v12"]), w("lcd1:SDA", "mega:SDA", "green", ["h-20", "*", "v20"]),
        w("lcd1:SCL", "mega:SCL", "blue", ["h-12", "*", "v28"]), w("lcd1:VCC", "mega:5V", "red", ["h-44", "*", "v-20"]),
        w("joystick1:VERT", "mega:A1", "orange", ["v58.7"]), w("joystick1:HORZ", "mega:A0", "green", ["v68.7"]), w("joystick1:GND", "mega:GND.3", "black", ["v78.7"]),
        w("joystick1:SEL", "mega:23", "purple", ["v8", "h-86.8", "v-136.3"]), w("joystick1:VCC", "mega:5V.2", "red", ["v4", "h-53", "v-151.8", "h-29"]),
      ],
    ),
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
