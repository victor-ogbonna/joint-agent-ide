/**
 * End-to-end test for the browser AVR flasher, with no Arduino attached.
 *
 * Two software bootloaders stand in for real silicon:
 *
 *   - MegaBootloader   — transcribed from stk500boot.c, the STK500v2
 *     bootloader actually burned into an Arduino Mega 2560. Source:
 *     ~/.platformio/packages/framework-arduino-avr/bootloaders/stk500v2/
 *     Notably it reads page data from a FIXED offset of msgBuffer+10 and
 *     writes with `do { ... size -= 2 } while (size)`, so a header of the
 *     wrong length or an odd byte count corrupts the chip.
 *   - Optiboot         — the STK500v1 bootloader on an Uno/Nano.
 *
 * Each runs at several USB chunk sizes, because the defect this test was
 * written for was precisely a reader that only worked when the bridge
 * happened to deliver one byte at a time. The flasher must produce a flash
 * image byte-identical to the input .hex in every case.
 *
 *   node --experimental-strip-types test/avrFlash.sim.mjs   (or: npm run test:flash)
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "avrflash-")), "avrFlash.mjs");
await build({
  entryPoints: [join(here, "..", "src", "lib", "avrFlash.ts")],
  bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent",
});
const { flashAvr } = await import(pathToFileURL(out).href);


// ---------------------------------------------------------------------------
// A faithful software model of stk500boot.c (the bootloader actually burned
// into an Arduino Mega 2560), transcribed from
//   ~/.platformio/packages/framework-arduino-avr/bootloaders/stk500v2/stk500boot.c
// Key behaviours copied verbatim from that source:
//   - frame: 0x1B, seq, len_hi, len_lo, 0x0E, body, XOR-checksum over all
//   - CMD_SIGN_ON  -> msgLength 11, [cmd, STATUS_OK, 8, "AVRISP_2"]
//   - CMD_LOAD_ADDRESS -> address = (b1<<24|b2<<16|b3<<8|b4) << 1   (RAMPZ part)
//   - CMD_PROGRAM_FLASH_ISP -> size = b1<<8|b2 ;  data pointer = msgBuffer+10
//                              do { lo=*p++; hi=*p++; ... size -= 2 } while(size)
//   - msgBuffer is 285 bytes
// ---------------------------------------------------------------------------
const MESSAGE_START = 0x1b, TOKEN = 0x0e, STATUS_CMD_OK = 0x00;
const CMD_SIGN_ON = 0x01, CMD_LOAD_ADDRESS = 0x06, CMD_ENTER_PROGMODE_ISP = 0x10,
      CMD_LEAVE_PROGMODE_ISP = 0x11, CMD_PROGRAM_FLASH_ISP = 0x13;

const FLASH_SIZE = 256 * 1024;

class MegaBootloader {
  constructor(opts = {}) {
    this.flash = new Uint8Array(FLASH_SIZE).fill(0xff);
    this.address = 0;
    this.rx = [];
    this.out = [];
    this.log = [];
    this.badFrames = 0;
    this.chunkBytes = opts.chunkBytes ?? 64;   // how the USB bridge batches replies
    this.running = false;                       // becomes true after reset
  }
  reset() { this.running = true; this.rx.length = 0; this.address = 0; }

  feed(bytes) {
    if (!this.running) return;                  // sketch is running, not the bootloader
    for (const b of bytes) this.rx.push(b);
    this.parse();
  }

  parse() {
    // Scan for complete frames.
    for (;;) {
      const i = this.rx.indexOf(MESSAGE_START);
      if (i < 0) { this.rx.length = 0; return; }
      if (i > 0) this.rx.splice(0, i);
      if (this.rx.length < 5) return;
      const seq = this.rx[1];
      const len = (this.rx[2] << 8) | this.rx[3];
      if (this.rx[4] !== TOKEN) { this.rx.shift(); this.badFrames++; continue; }
      if (len + 1 > 285) { this.rx.shift(); this.badFrames++; continue; }
      const total = 5 + len + 1;
      if (this.rx.length < total) return;
      const frame = this.rx.splice(0, total);
      let ck = 0; for (let k = 0; k < total - 1; k++) ck ^= frame[k];
      if (ck !== frame[total - 1]) { this.badFrames++; this.log.push("BAD CHECKSUM"); continue; }
      this.handle(seq, frame.slice(5, 5 + len));
    }
  }

  reply(seq, body) {
    const head = [MESSAGE_START, seq, (body.length >> 8) & 0xff, body.length & 0xff, TOKEN];
    let ck = 0; for (const b of [...head, ...body]) ck ^= b;
    this.out.push(...head, ...body, ck);
  }

  handle(seq, msg) {
    const cmd = msg[0];
    switch (cmd) {
      case CMD_SIGN_ON:
        this.log.push("SIGN_ON");
        this.reply(seq, [cmd, STATUS_CMD_OK, 8, ...Array.from("AVRISP_2", c => c.charCodeAt(0))]);
        break;
      case CMD_ENTER_PROGMODE_ISP:
        this.log.push("ENTER_PROGMODE");
        this.reply(seq, [cmd, STATUS_CMD_OK]);
        break;
      case CMD_LEAVE_PROGMODE_ISP:
        this.log.push("LEAVE_PROGMODE");
        this.reply(seq, [cmd, STATUS_CMD_OK]);
        break;
      case CMD_LOAD_ADDRESS: {
        // exactly as stk500boot.c does it for a RAMPZ part
        const a = ((msg[1] << 24) | (msg[2] << 16) | (msg[3] << 8) | msg[4]) >>> 0;
        this.address = (a << 1) >>> 0;
        this.log.push(`LOAD_ADDRESS -> byte 0x${this.address.toString(16)}`);
        this.reply(seq, [cmd, STATUS_CMD_OK]);
        break;
      }
      case CMD_PROGRAM_FLASH_ISP: {
        let size = (msg[1] << 8) | msg[2];
        let p = 10;                               // <-- the fixed offset
        if (size % 2 !== 0) { this.log.push("ODD SIZE -> would underflow on real silicon"); this.oddSize = true; }
        let addr = this.address;
        let words = 0;
        do {
          const lo = msg[p++], hi = msg[p++];
          if (lo === undefined || hi === undefined) { this.log.push("READ PAST END OF MESSAGE"); this.overran = true; break; }
          this.flash[addr] = lo; this.flash[addr + 1] = hi;
          addr += 2; size -= 2; words++;
          if (words > 4096) { this.log.push("RUNAWAY"); this.runaway = true; break; }
        } while (size);
        this.log.push(`PROGRAM_FLASH ${words * 2} bytes @0x${this.address.toString(16)}`);
        this.reply(seq, [cmd, STATUS_CMD_OK]);
        break;
      }
      default:
        this.log.push(`UNKNOWN 0x${cmd.toString(16)}`);
        this.reply(seq, [cmd, 0xc0]);
        break;
    }
  }

  // Deliver buffered output the way a USB-serial bridge would: in batches.
  drain() {
    if (!this.out.length) return null;
    return new Uint8Array(this.out.splice(0, this.chunkBytes));
  }
}

// --- a mock Web Serial port wired to the bootloader ---
function makePort(boot) {
  let ctrl;
  let readable = null, writable = null, open = false;
  let pump = null;
  return {
    boot,
    async open() {
      open = true;
      readable = new ReadableStream({ start(c) { ctrl = c; } });
      writable = new WritableStream({
        write(chunk) { boot.feed(chunk); },
      });
      pump = setInterval(() => {
        const d = boot.drain();
        if (d && ctrl) { try { ctrl.enqueue(d); } catch {} }
      }, 2);
    },
    async close() { if (!open) throw new Error("not open"); open = false; clearInterval(pump); },
    async setSignals({ dataTerminalReady }) {
      // falling edge of DTR (false -> true asserts, pulling RESET low) = reset
      if (dataTerminalReady === true) boot.reset();
    },
    get readable() { return readable; },
    get writable() { return writable; },
  };
}


const STK_OK=0x10, STK_INSYNC=0x14, CRC_EOP=0x20;
const GET_SYNC=0x30, ENTER_PROG=0x50, LEAVE_PROG=0x51, LOAD_ADDR=0x55, PROG_PAGE=0x64;
const READ_SIGN=0x75;   // optiboot answers this; avrdude uses it to identify the chip
const FLASH=32*1024;

class Optiboot {
  constructor(chunkBytes=64){ this.flash=new Uint8Array(FLASH).fill(0xff); this.addr=0;
    this.rx=[]; this.out=[]; this.log=[]; this.chunkBytes=chunkBytes; this.running=false; }
  reset(){ this.running=true; this.rx.length=0; }
  feed(b){ if(!this.running) return; for(const x of b) this.rx.push(x); this.parse(); }
  parse(){
    for(;;){
      if(!this.rx.length) return;
      const c=this.rx[0];
      let need, handler;
      if(c===GET_SYNC||c===ENTER_PROG||c===LEAVE_PROG||c===READ_SIGN){ need=2; }
      else if(c===LOAD_ADDR){ need=4; }
      else if(c===PROG_PAGE){
        if(this.rx.length<4) return;
        const len=(this.rx[1]<<8)|this.rx[2];
        need=4+len+1;
      } else { this.rx.shift(); continue; }
      if(this.rx.length<need) return;
      const msg=this.rx.splice(0,need);
      if(msg[need-1]!==CRC_EOP){ this.log.push("BAD CRC_EOP"); this.badEop=true; continue; }
      this.handle(c,msg);
    }
  }
  ok(body=[]){ this.out.push(STK_INSYNC,...body,STK_OK); }
  handle(c,msg){
    if(c===GET_SYNC){ this.log.push("SYNC"); this.ok(); }
    else if(c===ENTER_PROG){ this.log.push("ENTER"); this.ok(); }
    else if(c===LEAVE_PROG){ this.log.push("LEAVE"); this.ok(); }
    else if(c===LOAD_ADDR){ this.addr=((msg[2]<<8)|msg[1])<<1; this.log.push(`ADDR 0x${this.addr.toString(16)}`); this.ok(); }
    else if(c===PROG_PAGE){
      const len=(msg[1]<<8)|msg[2];
      if(msg[3]!==0x46){ this.log.push("not flash"); }
      for(let i=0;i<len;i++) this.flash[this.addr+i]=msg[4+i];
      this.log.push(`PAGE ${len}B @0x${this.addr.toString(16)}`);
      this.ok();
    }
    // ATmega328P. Real optiboot answers READ_SIGN, and answers unknown
    // commands with a bare INSYNC/OK through its default branch - the model
    // used to stay silent for both, which is LESS forgiving than the hardware
    // and made a faithful client look broken.
    else if(c===READ_SIGN){ this.log.push("SIGN"); this.ok([0x1e,0x95,0x0f]); }
    else { this.log.push(`UNKNOWN 0x${c.toString(16)}`); this.ok(); }
  }
  drain(){ return this.out.length? new Uint8Array(this.out.splice(0,this.chunkBytes)) : null; }
}
function makePortV1(boot){
  let ctrl,readable,writable,pump;
  return {
    async open(){ readable=new ReadableStream({start(c){ctrl=c;}});
      writable=new WritableStream({write(ch){boot.feed(ch);}});
      pump=setInterval(()=>{const d=boot.drain(); if(d&&ctrl){try{ctrl.enqueue(d);}catch{}}},2); },
    async close(){ clearInterval(pump); },
    async setSignals({dataTerminalReady}){ if(dataTerminalReady===true) boot.reset(); },
    get readable(){return readable;}, get writable(){return writable;},
  };
}
function makeHexV1(bytes){ const L=[];
  for(let i=0;i<bytes.length;i+=16){ const r=bytes.slice(i,i+16);
    const b=[r.length,(i>>8)&0xff,i&0xff,0x00,...r]; let s=0; for(const x of b)s+=x;
    L.push(":"+b.map(x=>x.toString(16).padStart(2,"0")).join("").toUpperCase()+(((~s+1)&0xff).toString(16).padStart(2,"0")).toUpperCase()); }
  L.push(":00000001FF"); return L.join("\n"); }


// --- shared helpers -------------------------------------------------------
function makeHex(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const rec = bytes.slice(i, i + 16);
    const b = [rec.length, (i >> 8) & 0xff, i & 0xff, 0x00, ...rec];
    let sum = 0; for (const x of b) sum += x;
    lines.push(":" + b.map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase() +
      (((~sum + 1) & 0xff).toString(16).padStart(2, "0")).toUpperCase());
  }
  lines.push(":00000001FF");
  return lines.join("\n");
}
const pattern = (n, k) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * k + 7) & 0xff; return a; };

let failures = 0;
const report = (line, ok) => { console.log(`${ok ? "  ok  " : "  FAIL"}  ${line}`); if (!ok) failures++; };

async function runMega(chunkBytes, label) {
  const SIZE = 1474;
  const program = pattern(SIZE, 31);
  const boot = new MegaBootloader({ chunkBytes });
  const port = makePort(boot);
  try {
    await flashAvr({ hex: makeHex(program), uploadProtocol: "wiring", uploadSpeed: 115200,
      chip: "ATMEGA2560", port, onProgress: () => {} });
  } catch (e) { return report(`${label} -> threw: ${e.message}`, false); }
  let bad = -1; for (let i = 0; i < SIZE; i++) if (boot.flash[i] !== program[i]) { bad = i; break; }
  if (bad >= 0) return report(`${label} -> flash corrupt at byte ${bad}`, false);
  const clean = !boot.oddSize && !boot.overran && !boot.runaway && boot.badFrames === 0;
  report(`${label} -> ${SIZE} bytes identical${clean ? "" : " (PROTOCOL FAULTS)"}`, clean);
}

async function runUno(chunkBytes, label) {
  const SIZE = 924;
  const program = pattern(SIZE, 17);
  const boot = new Optiboot(chunkBytes);
  const port = makePortV1(boot);
  try {
    await flashAvr({ hex: makeHex(program), uploadProtocol: "arduino", uploadSpeed: 115200,
      chip: "ATMEGA328P", port, onProgress: () => {} });
  } catch (e) { return report(`${label} -> threw: ${e.message}`, false); }
  let bad = -1; for (let i = 0; i < SIZE; i++) if (boot.flash[i] !== program[i]) { bad = i; break; }
  if (bad >= 0) return report(`${label} -> flash corrupt at byte ${bad}`, false);
  report(`${label} -> ${SIZE} bytes identical${boot.badEop ? " (BAD EOP)" : ""}`, !boot.badEop);
}

console.log("Arduino Mega 2560 — STK500v2 / wiring");
for (const [n, l] of [[256, "whole frames in one chunk"], [64, "64-byte USB packets     "], [7, "awkward 7-byte fragments"], [1, "one byte at a time      "]]) await runMega(n, l);
console.log("Arduino Uno — STK500v1 / optiboot");
for (const [n, l] of [[256, "whole replies in one chunk"], [64, "64-byte USB packets       "], [2, "2-byte packets            "], [1, "one byte at a time        "]]) await runUno(n, l);

console.log(failures ? `\n${failures} failing case(s)` : "\nAll cases passed.");
process.exit(failures ? 1 : 0);
