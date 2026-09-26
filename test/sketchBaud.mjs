/**
 * The serial monitor listens at the rate the sketch opens Serial at, however
 * the sketch writes it. A named rate (#define / const) used to be read as "no
 * Serial.begin at all": the monitor sat at 115200, a Mega printing at 9600
 * showed nothing, and it claimed the sketch never opened Serial.
 */
import { sketchSerial, sketchBaudRate, sketchOpensSerial } from "../src/lib/sketchBaud.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const baud = (src) => sketchSerial(src)?.baud ?? null;

check(baud("void setup(){ Serial.begin(9600); }") === 9600, "a literal rate");
check(baud("#define BAUD_RATE 9600\nvoid setup(){ Serial.begin(BAUD_RATE); }") === 9600, "a #define'd rate");
check(baud("const long SERIAL_BAUD = 57600;\nvoid setup(){ Serial.begin(SERIAL_BAUD); }") === 57600, "a const rate");
check(baud("static const uint32_t BAUD = 115200UL;\nvoid setup(){ Serial.begin(BAUD); }") === 115200, "a typed const with a UL suffix");
check(baud("constexpr int BAUD{9600};\nvoid setup(){ Serial.begin(BAUD); }") === 9600, "a brace-initialised constexpr");
check(baud("void setup(){ Serial.begin(115200L); }") === 115200, "a literal with an L suffix");
check(baud("void setup(){ Serial.begin(115200, SERIAL_8N1); }") === 115200, "a second argument (ESP32 config)");
check(baud("/* Serial.begin(9600) */\n// Serial.begin(4800);\nvoid setup(){ Serial.begin(38400); }") === 38400,
      "commented-out calls are ignored");
check(baud("void setup(){ Serial1.begin(9600); Serial.begin(19200); }") === 19200,
      "Serial1 (a Mega's hardware UART) is not the USB port");
check(sketchSerial("void setup(){ Serial1.begin(9600); }") === null, "only Serial1: the USB port is never opened");
check(!sketchOpensSerial("void setup(){ pinMode(13, OUTPUT); }"), "no Serial.begin at all");
{
  const r = sketchSerial("void setup(){ Serial.begin(rateFromEeprom()); }");
  check(r !== null && r.baud === null && sketchBaudRate("void setup(){ Serial.begin(rateFromEeprom()); }") === 115200,
        "an unreadable rate: opens Serial, falls back to 115200");
}

console.log(bad ? `\n${bad} failing case(s)` : "\nThe monitor's rate is read however the sketch writes it.");
process.exit(bad ? 1 : 0);
