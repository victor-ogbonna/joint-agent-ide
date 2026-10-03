/**
 * Intel HEX, as the compiler writes a program for an AVR board, into the
 * bytes of the chip's program memory.
 *
 * Every record's checksum is checked, and extended addresses (a Mega's
 * program can be past 64 KB) are followed. A program that doesn't fit the
 * chip, or a damaged file, is refused with a reason rather than run half.
 */
export function parseIntelHex(text: string, flashBytes: number): Uint8Array {
  const out = new Uint8Array(flashBytes);
  let base = 0;
  let sawEnd = false;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    if (line[0] !== ":" || line.length < 11 || (line.length - 1) % 2 !== 0) {
      throw new Error(`The program file is damaged (line ${n + 1}).`);
    }
    const bytes: number[] = [];
    for (let i = 1; i < line.length; i += 2) {
      const b = parseInt(line.slice(i, i + 2), 16);
      if (Number.isNaN(b)) throw new Error(`The program file is damaged (line ${n + 1}).`);
      bytes.push(b);
    }
    const len = bytes[0];
    if (bytes.length !== len + 5) throw new Error(`The program file is damaged (line ${n + 1}).`);
    if ((bytes.reduce((a, b) => a + b, 0) & 0xff) !== 0) throw new Error(`The program file is damaged (checksum, line ${n + 1}).`);
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.slice(4, 4 + len);
    if (type === 0x00) {
      const at = base + addr;
      if (at + len > flashBytes) throw new Error("The program is too big for this board's memory.");
      out.set(data, at);
    } else if (type === 0x01) {
      sawEnd = true;
      break;
    } else if (type === 0x02) {
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 0x04) {
      base = ((data[0] << 8) | data[1]) << 16;
    }
    // 0x03 and 0x05 (start addresses) don't place any bytes.
  }
  if (!sawEnd) throw new Error("The program file is incomplete.");
  return out;
}
