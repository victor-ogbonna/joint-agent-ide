/**
 * The chips inside display and clock parts, driven the way their libraries
 * drive the real ones:
 *  - HD44780, the controller of 16×2 and 20×4 character LCDs (LiquidCrystal);
 *  - PCF8574, the I2C backpack on those LCDs (LiquidCrystal_I2C);
 *  - SSD1306, the 128×64 OLED (Adafruit_SSD1306, U8g2);
 *  - DS1307, the real-time clock (RTClib).
 */
import type { I2CDevice } from "./circuit";

// ---- HD44780 ----

export interface LcdSnapshot {
  version: number;
  /** The character code shown at each position, row by row. */
  characters: Uint8Array;
  /** The 8 user-defined characters (createChar), 8 rows of 5 bits each. */
  cgram: Uint8Array;
  cursor: boolean;
  blink: boolean;
  cursorX: number;
  cursorY: number;
  /** Whether the program has turned the display on. */
  on: boolean;
}

export class Hd44780 {
  version = 0;
  private ddram = new Uint8Array(128).fill(0x20);
  private cgram = new Uint8Array(64);
  private ac = 0;
  private toCgram = false;
  private increment = true;
  private shiftOnWrite = false;
  private on = false;
  private cursor = false;
  private blink = false;
  private eightBit = true;
  private twoLine = true;
  private nibble: number | null = null;
  /** The address shown in the first column (display shift). */
  private offset = 0;

  constructor(readonly cols: number, readonly rows: number) {}

  /** One transfer, as E falls: RS (data or command) and the data lines D7-D0. */
  write(rs: boolean, lines: number) {
    let byte = lines & 0xff;
    if (!this.eightBit) {
      // 4-bit: the high half, then the low half, both on D7-D4.
      if (this.nibble === null) { this.nibble = byte & 0xf0; return; }
      byte = this.nibble | ((byte & 0xf0) >> 4);
      this.nibble = null;
    }
    if (rs) this.data(byte); else this.command(byte);
    this.version++;
  }

  private nextAddress(a: number, up: boolean) {
    if (!this.twoLine) return (a + (up ? 1 : 79)) % 80;
    if (up) return a === 0x27 ? 0x40 : a === 0x67 ? 0x00 : a + 1;
    return a === 0x40 ? 0x27 : a === 0x00 ? 0x67 : a - 1;
  }

  private command(c: number) {
    if (c & 0x80) { this.toCgram = false; this.ac = c & 0x7f; return; }
    if (c & 0x40) { this.toCgram = true; this.ac = c & 0x3f; return; }
    if (c & 0x20) {
      this.eightBit = !!(c & 0x10);
      this.twoLine = !!(c & 0x08);
      this.nibble = null;
      return;
    }
    if (c & 0x10) {
      const right = !!(c & 0x04);
      if (c & 0x08) this.offset = (this.offset + (right ? 39 : 1)) % 40;
      else this.ac = this.nextAddress(this.ac, right);
      return;
    }
    if (c & 0x08) { this.on = !!(c & 0x04); this.cursor = !!(c & 0x02); this.blink = !!(c & 0x01); return; }
    if (c & 0x04) { this.increment = !!(c & 0x02); this.shiftOnWrite = !!(c & 0x01); return; }
    if (c & 0x02) { this.ac = 0; this.toCgram = false; this.offset = 0; return; }
    if (c & 0x01) { this.ddram.fill(0x20); this.ac = 0; this.toCgram = false; this.offset = 0; this.increment = true; }
  }

  private data(d: number) {
    if (this.toCgram) {
      this.cgram[this.ac & 0x3f] = d & 0x1f;
      this.ac = (this.ac + (this.increment ? 1 : 63)) & 0x3f;
      return;
    }
    this.ddram[this.ac] = d;
    this.ac = this.nextAddress(this.ac, this.increment);
    if (this.shiftOnWrite) this.offset = (this.offset + (this.increment ? 1 : 39)) % 40;
  }

  /** The DDRAM address shown at a row and column. */
  private addressAt(row: number, col: number): number | null {
    if (!this.twoLine) return row === 0 ? (col + this.offset) % 80 : null;
    const line = row % 2;
    const pos = (row >= 2 ? this.cols : 0) + col;
    return (line ? 0x40 : 0) + ((pos + this.offset) % 40);
  }

  /** The text written by the program, row by row (for checks and copy). */
  text(): string[] {
    const s = this.snapshot();
    return Array.from({ length: this.rows }, (_, r) => String.fromCharCode(...s.characters.subarray(r * this.cols, (r + 1) * this.cols)));
  }

  snapshot(): LcdSnapshot {
    const characters = new Uint8Array(this.cols * this.rows).fill(0x20);
    if (this.on) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const a = this.addressAt(r, c);
          if (a !== null) characters[r * this.cols + c] = this.ddram[a];
        }
      }
    }
    let cursorX = -1;
    let cursorY = -1;
    if (!this.toCgram) {
      for (let r = 0; r < this.rows && cursorX < 0; r++) {
        for (let c = 0; c < this.cols; c++) if (this.addressAt(r, c) === this.ac) { cursorX = c; cursorY = r; break; }
      }
    }
    const visible = this.on && cursorX >= 0;
    return {
      version: this.version,
      characters,
      cgram: this.cgram.slice(),
      cursor: visible && this.cursor,
      blink: visible && this.blink,
      cursorX: Math.max(0, cursorX),
      cursorY: Math.max(0, cursorY),
      on: this.on,
    };
  }
}

// ---- PCF8574 (I2C backpack) ----

export class Pcf8574 implements I2CDevice {
  private value = 0xff;
  constructor(private onWrite: (value: number, old: number) => void) {}
  connect() { return true; }
  write(byte: number) {
    const old = this.value;
    this.value = byte & 0xff;
    this.onWrite(this.value, old);
    return true;
  }
  read() { return this.value; }
  stop() {}
}

// ---- SSD1306 ----

/** Commands followed by arguments, and how many. */
const SSD1306_ARGS: Record<number, number> = {
  0x81: 1, 0x20: 1, 0x21: 2, 0x22: 2, 0xa8: 1, 0xd3: 1, 0xda: 1, 0xd5: 1, 0xd9: 1, 0xdb: 1, 0x8d: 1,
  0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2,
};

export class Ssd1306 implements I2CDevice {
  version = 0;
  /** Display memory: 8 pages of 128 columns, one byte = 8 pixels down. */
  readonly ram = new Uint8Array(128 * 8);
  private on = false;
  private invert = false;
  private allOn = false;
  private mode = 2;
  private col = 0;
  private page = 0;
  private colStart = 0;
  private colEnd = 127;
  private pageStart = 0;
  private pageEnd = 7;
  private segRemap = false;
  private comReverse = false;
  private startLine = 0;
  private expectControl = true;
  private continuous = false;
  private dataMode = false;
  private pending: number | null = null;
  private args: number[] = [];

  connect() { this.expectControl = true; return true; }
  stop() { this.expectControl = true; }
  read() { return 0; }

  write(byte: number) {
    if (this.expectControl) {
      this.continuous = !(byte & 0x80);
      this.dataMode = !!(byte & 0x40);
      this.expectControl = false;
      return true;
    }
    if (this.dataMode) this.data(byte); else this.commandByte(byte);
    if (!this.continuous) this.expectControl = true;
    return true;
  }

  private commandByte(b: number) {
    if (this.pending !== null) {
      this.args.push(b);
      if (this.args.length >= (SSD1306_ARGS[this.pending] ?? 0)) {
        const cmd = this.pending;
        this.pending = null;
        this.exec(cmd, this.args);
      }
      return;
    }
    if (SSD1306_ARGS[b]) { this.pending = b; this.args = []; return; }
    this.exec(b, []);
  }

  private exec(c: number, a: number[]) {
    const before = [this.on, this.invert, this.allOn, this.segRemap, this.comReverse, this.startLine].join();
    if (c === 0xae || c === 0xaf) this.on = c === 0xaf;
    else if (c === 0xa4 || c === 0xa5) this.allOn = c === 0xa5;
    else if (c === 0xa6 || c === 0xa7) this.invert = c === 0xa7;
    else if (c === 0xa0 || c === 0xa1) this.segRemap = c === 0xa1;
    else if (c === 0xc0 || c === 0xc8) this.comReverse = c === 0xc8;
    else if (c === 0x20) this.mode = a[0] & 3;
    else if (c === 0x21) { this.colStart = a[0] & 0x7f; this.colEnd = a[1] & 0x7f; this.col = this.colStart; }
    else if (c === 0x22) { this.pageStart = a[0] & 7; this.pageEnd = a[1] & 7; this.page = this.pageStart; }
    else if (c <= 0x0f) this.col = (this.col & 0xf0) | c;
    else if (c <= 0x1f) this.col = ((c & 0x07) << 4) | (this.col & 0x0f);
    else if (c >= 0xb0 && c <= 0xb7) this.page = c & 7;
    else if (c >= 0x40 && c <= 0x7f) this.startLine = c & 0x3f;
    if (before !== [this.on, this.invert, this.allOn, this.segRemap, this.comReverse, this.startLine].join()) this.version++;
  }

  private data(byte: number) {
    this.ram[this.page * 128 + this.col] = byte;
    this.version++;
    if (this.mode === 0) {
      if (++this.col > this.colEnd) { this.col = this.colStart; if (++this.page > this.pageEnd) this.page = this.pageStart; }
    } else if (this.mode === 1) {
      if (++this.page > this.pageEnd) { this.page = this.pageStart; if (++this.col > this.colEnd) this.col = this.colStart; }
    } else if (++this.col > 127) {
      this.col = 0;
    }
  }

  /** What the screen shows: 128×64, one byte per pixel (1 lit). */
  render(): Uint8Array {
    const out = new Uint8Array(128 * 64);
    if (!this.on) return out;
    for (let y = 0; y < 64; y++) {
      const row = ((this.comReverse ? y : 63 - y) + this.startLine) & 63;
      const base = (row >> 3) * 128;
      const bit = 1 << (row & 7);
      for (let x = 0; x < 128; x++) {
        const col = this.segRemap ? x : 127 - x;
        let lit = this.allOn || !!(this.ram[base + col] & bit);
        if (this.invert) lit = !lit;
        out[y * 128 + x] = lit ? 1 : 0;
      }
    }
    return out;
  }
}

// ---- DS1307 ----

const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const fromBcd = (b: number) => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);

export class Ds1307 implements I2CDevice {
  private ram = new Uint8Array(64);
  private pointer = 0;
  private first = false;
  private wroteTime = false;
  /** Local wall-clock milliseconds when simulated time was 0. */
  private base: number;
  private halted: number | null = null;

  constructor(private seconds: () => number) {
    const now = new Date();
    this.base = now.getTime() - now.getTimezoneOffset() * 60_000;
    this.ram[7] = 0x03;
  }

  private nowMs() {
    return this.halted ?? this.base + this.seconds() * 1000;
  }

  private timeRegisters(): number[] {
    const d = new Date(this.nowMs());
    return [
      bcd(d.getUTCSeconds()) | (this.halted !== null ? 0x80 : 0),
      bcd(d.getUTCMinutes()),
      bcd(d.getUTCHours()),
      d.getUTCDay() === 0 ? 7 : d.getUTCDay(),
      bcd(d.getUTCDate()),
      bcd(d.getUTCMonth() + 1),
      bcd(d.getUTCFullYear() % 100),
    ];
  }

  connect(write: boolean) {
    this.first = write;
    if (write) {
      const regs = this.timeRegisters();
      for (let i = 0; i < 7; i++) this.ram[i] = regs[i];
      this.wroteTime = false;
    }
    return true;
  }

  write(byte: number) {
    if (this.first) { this.pointer = byte & 0x3f; this.first = false; return true; }
    if (this.pointer < 7) this.wroteTime = true;
    this.ram[this.pointer] = byte;
    this.pointer = (this.pointer + 1) & 0x3f;
    return true;
  }

  read() {
    const value = this.pointer < 7 ? this.timeRegisters()[this.pointer] : this.ram[this.pointer];
    this.pointer = (this.pointer + 1) & 0x3f;
    return value;
  }

  stop() {
    if (!this.wroteTime) return;
    this.wroteTime = false;
    const r = this.ram;
    const ms = Date.UTC(2000 + fromBcd(r[6]), Math.max(0, fromBcd(r[5] & 0x1f) - 1), Math.max(1, fromBcd(r[4] & 0x3f)), fromBcd(r[2] & 0x3f), fromBcd(r[1] & 0x7f), fromBcd(r[0] & 0x7f));
    if (r[0] & 0x80) this.halted = ms;
    else { this.halted = null; this.base = ms - this.seconds() * 1000; }
  }
}
