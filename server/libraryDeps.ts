// ----------------------------------------------------
// Shared #include -> PlatformIO lib_deps detection, used identically by
// both /api/compile and /api/flash so a library that resolves for one
// resolves for the other. (Previously each endpoint had its own copy of
// this map; the /api/flash copy had drifted and was missing ~half the
// entries, plus had no fallback for unmapped headers — code could compile
// fine but silently fail to flash.)
// ----------------------------------------------------
const LIBRARY_MAP: Record<string, string> = {
  // Temperature & Humidity
  'DHT': 'adafruit/DHT sensor library@^1.4.6',
  'DHT_U': 'adafruit/DHT sensor library@^1.4.6',
  'Adafruit_Sensor': 'adafruit/Adafruit Unified Sensor@^1.1.14',
  'OneWire': 'paulstoffregen/OneWire@^2.3.8',
  'DallasTemperature': 'milesburton/DallasTemperature@^3.11.0',
  'BME280': 'adafruit/Adafruit BME280 Library@^2.2.4',
  'Adafruit_BME280': 'adafruit/Adafruit BME280 Library@^2.2.4',
  'Adafruit_BMP280': 'adafruit/Adafruit BMP280 Library@^2.6.8',
  // LCD & Display
  'LiquidCrystal': 'arduino-libraries/LiquidCrystal@^1.0.7',
  'LiquidCrystal_I2C': 'marcoschwartz/LiquidCrystal_I2C@^1.1.4',
  'Adafruit_SSD1306': 'adafruit/Adafruit SSD1306@^2.5.9',
  'Adafruit_GFX': 'adafruit/Adafruit GFX Library@^1.11.9',
  'U8g2lib': 'olikraus/U8g2@^2.35.19',
  'TFT_eSPI': 'bodmer/TFT_eSPI@^2.5.43',
  // Servo & Motor
  'Servo': 'arduino-libraries/Servo@^1.2.2',
  'ESP32Servo': 'madhephaestus/ESP32Servo@^3.0.5',
  'AccelStepper': 'waspinator/AccelStepper@^1.64',
  'Stepper': 'arduino-libraries/Stepper@^1.1.3',
  // Communication
  'WiFi': '',  // built-in for ESP32
  'WiFiManager': 'tzapu/WiFiManager@^2.0.17',
  'PubSubClient': 'knolleary/PubSubClient@^2.8',
  'ArduinoJson': 'bblanchon/ArduinoJson@^7.1.0',
  'AsyncTCP': 'me-no-dev/AsyncTCP@^1.1.1',
  'ESPAsyncWebServer': 'me-no-dev/ESPAsyncWebServer@^1.2.4',
  'ArduinoWebsockets': 'gilmaimon/ArduinoWebsockets@^0.5.4',
  'HTTPClient': '',  // built-in for ESP32
  'BluetoothSerial': '',  // built-in for ESP32
  'BLEDevice': '',  // built-in for ESP32
  // NeoPixel & LED
  'Adafruit_NeoPixel': 'adafruit/Adafruit NeoPixel@^1.12.3',
  'FastLED': 'fastled/FastLED@^3.7.1',
  // Sensors
  'IRremote': 'crankyoldgit/IRremoteESP8266@^2.8.6',
  'NewPing': 'teckel12/NewPing@^1.9.7',
  'Adafruit_MPU6050': 'adafruit/Adafruit MPU6050@^2.2.6',
  'MPU6050': 'electroniccats/MPU6050@^1.3.1',
  'HX711': 'bogde/HX711@^0.7.5',
  'Keypad': 'chris--a/Keypad@^3.1.1',
  // Storage
  'SD': '',  // built-in
  'SPIFFS': '',  // built-in
  'Preferences': '',  // built-in for ESP32
  'ArduinoOTA': '',  // built-in for ESP32
  // Firebase
  'Firebase_ESP_Client': 'mobizt/Firebase Arduino Client Library for ESP8266 and ESP32@^4.4.14',
  'FirebaseESP32': 'mobizt/Firebase ESP32 Client@^4.3.20',
  // Real Time Clock
  'RTClib': 'adafruit/RTClib@^2.1.4',
  'NTPClient': 'arduino-libraries/NTPClient@^3.2.1',
  // Audio
  'I2S': '',  // built-in for ESP32
  // Misc
  'SoftwareSerial': 'plerup/EspSoftwareSerial@^8.2.0',
  'Ticker': '',  // built-in
  'EEPROM': '',  // built-in
  'Wire': '',  // built-in
  'SPI': '',  // built-in
  'FS': '',  // built-in
  'Update': '',  // built-in
  'WebServer': '',  // built-in
  'DNSServer': '',  // built-in
  'WiFiClientSecure': '',  // built-in
};

const KNOWN_STDLIB_HEADERS = ['Arduino', 'Wire', 'SPI', 'EEPROM', 'math', 'string', 'stdio', 'stdlib', 'stdint', 'avr/io', 'avr/interrupt'];

// Parses #include directives (both <lib.h> and <lib/sub.h> forms) and
// returns the PlatformIO lib_deps entries to write into platformio.ini.
export function detectLibDeps(code: string): string[] {
  const includeMatches = [...code.matchAll(/#include\s*[<"]([^>"]+)[>"]/g)];
  const detected = new Set<string>();

  for (const match of includeMatches) {
    const headerPath = match[1];
    const headerName = headerPath.replace(/\.h$/, '').split('/').pop() || '';

    if (LIBRARY_MAP.hasOwnProperty(headerName)) {
      const libDep = LIBRARY_MAP[headerName];
      if (libDep) detected.add(libDep); // skip empty strings (built-ins)
    } else if (headerName && !KNOWN_STDLIB_HEADERS.includes(headerName)) {
      // Unknown library — best-guess by passing the bare name to PlatformIO's registry search
      detected.add(headerName);
    }
  }

  if (detected.has('adafruit/DHT sensor library@^1.4.6')) {
    detected.add('adafruit/Adafruit Unified Sensor@^1.1.14');
  }

  return Array.from(detected);
}
