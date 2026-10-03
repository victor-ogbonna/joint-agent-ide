/**
 * The boards the simulator runs: which chip, how much memory, and which
 * Arduino pin is which bit of which port (from each board's own
 * pins_arduino.h), plus how the board drawing names its pins.
 */
export type BoardId = "uno" | "nano" | "mega" | "esp32";

/** Whether `key` is an object's own entry (a diagram's text is never "__proto__" or "constructor" of a lookup table). */
export const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
export type Chip = "atmega328p" | "atmega2560" | "esp32";

export interface PinBit {
  /** Port letter, "B" for PORTB. */
  port: string;
  bit: number;
}

export interface BoardDef {
  id: BoardId;
  name: string;
  chip: Chip;
  /** The drawing (@wokwi/elements). */
  element: string;
  /** The build target a compile uses. */
  buildBoard: string;
  flashBytes: number;
  /** Data memory, registers and I/O included. */
  dataBytes: number;
  /** Arduino digital pin number → port bit. */
  digital: PinBit[];
  /** Analog input name → ADC channel. A6 and A7 on a Nano are analog only. */
  analog: Record<string, number>;
  /** Analog name → its digital pin number, where it has one. */
  analogDigital: Record<string, number>;
  sda: string;
  scl: string;
}

const P = (port: string, bit: number): PinBit => ({ port, bit });

// Uno and Nano: D0-D7 PORTD, D8-D13 PORTB, A0-A5 (D14-D19) PORTC.
const ATMEGA328_DIGITAL: PinBit[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((b) => P("D", b)),
  ...[0, 1, 2, 3, 4, 5].map((b) => P("B", b)),
  ...[0, 1, 2, 3, 4, 5].map((b) => P("C", b)),
];

// Mega 2560, from variants/mega/pins_arduino.h (digital_pin_to_port_PGM, _bit_mask_PGM).
const MEGA_PORTS = "E E E E G E H H H H B B B B J J H H D D D D A A A A A A A A C C C C C C C C D G G G L L L L L L L L B B B B F F F F F F F F K K K K K K K K".split(" ");
const MEGA_BITS = [0, 1, 4, 5, 5, 3, 3, 4, 5, 6, 4, 5, 6, 7, 1, 0, 1, 0, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0, 7, 2, 1, 0, 7, 6, 5, 4, 3, 2, 1, 0, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
const MEGA_DIGITAL: PinBit[] = MEGA_PORTS.map((port, i) => P(port, MEGA_BITS[i]));

const analogNames = (count: number, firstDigital: number | null, digitalCount = count) => {
  const analog: Record<string, number> = {};
  const analogDigital: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    analog[`A${i}`] = i;
    if (firstDigital !== null && i < digitalCount) analogDigital[`A${i}`] = firstDigital + i;
  }
  return { analog, analogDigital };
};

export const BOARDS: Record<BoardId, BoardDef> = {
  uno: {
    id: "uno", name: "Arduino Uno", chip: "atmega328p", element: "wokwi-arduino-uno", buildBoard: "uno",
    flashBytes: 32 * 1024, dataBytes: 0x900, digital: ATMEGA328_DIGITAL, ...analogNames(6, 14), sda: "A4", scl: "A5",
  },
  nano: {
    id: "nano", name: "Arduino Nano", chip: "atmega328p", element: "wokwi-arduino-nano", buildBoard: "nanoatmega328",
    flashBytes: 32 * 1024, dataBytes: 0x900, digital: ATMEGA328_DIGITAL, ...analogNames(8, 14, 6), sda: "A4", scl: "A5",
  },
  mega: {
    id: "mega", name: "Arduino Mega", chip: "atmega2560", element: "wokwi-arduino-mega", buildBoard: "megaatmega2560",
    flashBytes: 256 * 1024, dataBytes: 0x2200, digital: MEGA_DIGITAL, ...analogNames(16, 54), sda: "20", scl: "21",
  },
  // GPIO 0-39 (the "port" is only a label: the chip runs on the simulation
  // server, which reads its pins by GPIO number). Its analog inputs are GPIOs
  // too, so they are digital pins here, read as analog by the server.
  esp32: {
    id: "esp32", name: "ESP32 DevKit", chip: "esp32", element: "wokwi-esp32-devkit-v1", buildBoard: "esp32dev",
    flashBytes: 4 * 1024 * 1024, dataBytes: 0, digital: Array.from({ length: 40 }, (_, gpio) => P("GPIO", gpio)),
    analog: {}, analogDigital: {}, sda: "21", scl: "22",
  },
};

/** The ESP32 DevKit's pins named for what they do rather than their GPIO. */
const ESP32_NAMED_PINS: Record<string, number> = { TX0: 1, RX0: 3, TX2: 17, RX2: 16, VP: 36, VN: 39 };

/** Whether a board's chip is an ESP32 (simulated on the server, not in the page). */
export const isEsp32Board = (board: BoardDef) => board.chip === "esp32";

/** What a board pin is, by the name its drawing gives it. */
export type BoardPin =
  | { kind: "digital"; pin: number }
  | { kind: "analog-only"; channel: number }
  | { kind: "power"; volts: number }
  | { kind: "ground" }
  | { kind: "none" };

/**
 * A drawing's pin name → what it is. Copies of a pin on other headers
 * ("A4.2", "12.2", "5V.2", "GND.3") are the same pin; the Mega's SDA/SCL
 * header is pins 20 and 21.
 */
export function boardPin(board: BoardDef, rawName: string): BoardPin {
  const name = rawName.replace(/\.\d+$/, "");
  if (name === "GND") return { kind: "ground" };
  if (board.chip === "esp32") {
    if (name === "VIN") return { kind: "power", volts: 5 };
    if (name === "3V3") return { kind: "power", volts: 3.3 };
    if (own(ESP32_NAMED_PINS, name)) return { kind: "digital", pin: ESP32_NAMED_PINS[name] };
    // EN is the chip's reset: no GPIO.
    if (/^D\d+$/.test(name)) {
      const pin = Number(name.slice(1));
      return pin < board.digital.length ? { kind: "digital", pin } : { kind: "none" };
    }
    return { kind: "none" };
  }
  if (name === "5V" || name === "IOREF" || name === "VIN") return { kind: "power", volts: 5 };
  if (name === "3.3V" || name === "3V3") return { kind: "power", volts: 3.3 };
  if (name === "SDA" && board.id === "mega") return { kind: "digital", pin: 20 };
  if (name === "SCL" && board.id === "mega") return { kind: "digital", pin: 21 };
  if (/^D?\d+$/.test(name)) {
    const pin = Number(name.replace(/^D/, ""));
    return pin < board.digital.length ? { kind: "digital", pin } : { kind: "none" };
  }
  if (own(board.analog, name)) {
    return own(board.analogDigital, name) ? { kind: "digital", pin: board.analogDigital[name] } : { kind: "analog-only", channel: board.analog[name] };
  }
  return { kind: "none" };
}

/** The ADC channel a digital pin reads as an analog input, if it is one. */
export function analogChannelOf(board: BoardDef, pin: number): number | null {
  for (const [name, d] of Object.entries(board.analogDigital)) if (d === pin) return board.analog[name];
  return null;
}
