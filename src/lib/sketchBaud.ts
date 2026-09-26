/**
 * The baud rate a sketch opens its USB serial port at, so the serial monitor
 * listens at the same speed.
 *
 * Reading only a literal — Serial.begin(9600) — was not enough. The agent
 * often names the rate: `#define BAUD_RATE 9600` or `const long BAUD = 9600;`
 * and then Serial.begin(BAUD_RATE). That was read as "no Serial.begin at all":
 * the monitor listened at 115200, the board's 9600 output was all misframed,
 * and the monitor showed nothing while claiming the sketch never opened Serial.
 */

/** Code with comments removed, so a note like "monitor at 9600" cannot count. */
function stripComments(src: string): string {
  return (src || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const RATE = /^\d{3,7}$/;

/**
 * What the sketch passes to Serial.begin():
 *   - { baud }            a rate it could read (literal, #define or constant)
 *   - { baud: null, opens: true }  Serial.begin() with something it could not resolve
 *   - null                the sketch never calls Serial.begin()
 */
export function sketchSerial(src: string): { baud: number | null; opens: true } | null {
  const code = stripComments(src);
  // Serial only: Serial1..3 on a Mega are hardware UARTs, not the USB port the
  // monitor reads. \b keeps Serial1.begin from matching.
  const call = code.match(/\bSerial\s*\.\s*begin\s*\(\s*([^,)]+?)\s*[,)]/);
  if (!call) return null;
  const arg = call[1].trim().replace(/[uUlL]+$/, ""); // 9600UL, 115200L
  if (RATE.test(arg)) return { baud: Number(arg), opens: true };

  if (/^[A-Za-z_]\w*$/.test(arg)) {
    const name = arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const define = code.match(new RegExp(`#\\s*define\\s+${name}\\s+\\(?\\s*(\\d{3,7})[uUlL]*\\s*\\)?`));
    if (define) return { baud: Number(define[1]), opens: true };
    // const long BAUD = 9600;  static const uint32_t BAUD = 115200UL;  constexpr int BAUD{9600};
    const constant = code.match(new RegExp(`\\b${name}\\s*(?:=\\s*|\\{\\s*)\\(?\\s*(\\d{3,7})[uUlL]*`));
    if (constant) return { baud: Number(constant[1]), opens: true };
  }
  return { baud: null, opens: true };
}

/** Whether the sketch opens its USB serial port at all. */
export function sketchOpensSerial(src: string): boolean {
  return sketchSerial(src) !== null;
}

/** The rate the monitor should open at: the sketch's own, else 115200. */
export function sketchBaudRate(src: string): number {
  return sketchSerial(src)?.baud ?? 115200;
}
