/**
 * A Web Serial-shaped adapter over WebUSB, so phones can flash.
 *
 * Chrome on Android has no Web Serial, but it does have WebUSB. The difference
 * is that WebUSB hands you raw endpoints: nothing configures the baud rate or
 * drives DTR/RTS for you, because that is the USB-serial bridge chip's own
 * vendor protocol. So this file is a small driver per bridge family, wrapped in
 * the exact surface `flashAvr()` and esptool-js already consume —
 * `open/close/setSignals/getInfo` plus `readable`/`writable`. Nothing in the
 * STK500 or ESP32 code has to know which transport it is running on.
 *
 * Register-level details follow the Linux kernel drivers (ch341.c, cp210x.c,
 * ftdi_sio.c) and the USB CDC-ACM spec, which are the authoritative sources.
 */

type Signals = { dataTerminalReady?: boolean; requestToSend?: boolean };

export type BridgeKind = "cdc" | "ch34x" | "cp210x" | "ftdi";

/** USB vendor ids we know how to drive, with the driver each one needs. */
const VENDOR_DRIVERS: Array<{ vendorId: number; kind: BridgeKind; label: string }> = [
  { vendorId: 0x1a86, kind: "ch34x", label: "CH340/CH341" },
  { vendorId: 0x10c4, kind: "cp210x", label: "CP210x" },
  { vendorId: 0x0403, kind: "ftdi", label: "FTDI" },
];

/** Devices worth offering in Chrome's picker. */
export const USB_DEVICE_FILTERS = [
  { vendorId: 0x2341 }, // Arduino
  { vendorId: 0x2a03 }, // Arduino (legacy)
  { vendorId: 0x1b4f }, // SparkFun
  { vendorId: 0x239a }, // Adafruit
  { vendorId: 0x303a }, // Espressif native USB
  { vendorId: 0x1a86 }, // CH340
  { vendorId: 0x10c4 }, // CP210x
  { vendorId: 0x0403 }, // FTDI
];

const USB_CLASS_CDC_DATA = 0x0a;
const USB_CLASS_CDC_COMM = 0x02;

export function isWebUsbAvailable(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/**
 * Pick the driver. A vendor-specific bridge is decided by its USB vendor id;
 * anything else that exposes a CDC data interface is a standard CDC-ACM device
 * (a genuine Uno/Mega's ATmega16U2, or an ESP32-S3's native USB).
 */
function driverFor(device: any): BridgeKind | null {
  const known = VENDOR_DRIVERS.find((v) => v.vendorId === device.vendorId);
  if (known) return known.kind;
  for (const cfg of device.configurations || []) {
    for (const iface of cfg.interfaces || []) {
      for (const alt of iface.alternates || []) {
        if (alt.interfaceClass === USB_CLASS_CDC_DATA) return "cdc";
      }
    }
  }
  return null;
}

export class WebUsbSerialPort {
  private device: any;
  private kind: BridgeKind;
  private ifaceNumber = 0;
  private commIfaceNumber: number | null = null;
  private epIn = 0;
  private epOut = 0;
  private epInPacketSize = 64;
  /** Raw, pre-strip packets from the first reads, for diagnosing framing.
   *  Inferring the layout from post-strip bytes has proved unreliable — this
   *  records what the wire actually carried. */
  readonly rawLog: string[] = [];

  /** Endpoint geometry plus those raw packets, for a failure message. */
  describeFraming(): string {
    return `bridge=${this.kind} epIn=${this.epIn} packetSize=${this.epInPacketSize}` +
      (this.rawLog.length ? ` raw: ${this.rawLog.join(" | ")}` : " raw: (nothing read)");
  }
  private pumping = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private dtr = false;
  private rts = false;
  /** Last configured baud, so re-opening at the same rate is a no-op. */
  private baudRate = 0;

  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  constructor(device: any, kind: BridgeKind) {
    this.device = device;
    this.kind = kind;
  }

  getInfo() {
    return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
  }

  get opened(): boolean {
    return this.device.opened && this.readable !== null;
  }

  async open({ baudRate = 115200 }: { baudRate?: number } = {}): Promise<void> {
    // Re-open rather than throw. esptool-js opens the port itself, and a
    // caller that opened it first (board detection, or an attempt that died
    // before its finally ran) would otherwise get "The port is already open"
    // surfaced as esptool's generic "Failed to connect with the device" —
    // blaming the board for a state problem on this side.
    // Already open: reconfigure the baud if it changed and keep everything
    // else. Tearing the port down and rebuilding it re-inits the bridge and
    // drops DTR/RTS — which would undo a reset the caller just applied, and
    // esptool-js opens the port itself AFTER we have put the chip into
    // download mode.
    if (this.readable) {
      if (baudRate !== this.baudRate) {
        await this.configure(baudRate);
        this.baudRate = baudRate;
      }
      return;
    }
    if (!this.device.opened) await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);

    this.findEndpoints();

    try {
      await this.device.claimInterface(this.ifaceNumber);
    } catch (e: any) {
      throw new Error(
        `Could not claim the USB device (${e?.message || e}). On Android, close any other app using it and reconnect the cable.`
      );
    }
    if (this.commIfaceNumber !== null && this.commIfaceNumber !== this.ifaceNumber) {
      // Best effort: the control interface is what carries CDC line coding.
      try { await this.device.claimInterface(this.commIfaceNumber); } catch { /* some stacks expose it read-only */ }
    }

    await this.configure(baudRate);
    this.baudRate = baudRate;
    this.startPump();
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => { await this.device.transferOut(this.epOut, chunk); },
    });
  }

  /** Locate the bulk IN/OUT pair, preferring a CDC data interface when present. */
  private findEndpoints(): void {
    const cfg = this.device.configuration;
    if (!cfg) throw new Error("The USB device exposed no configuration.");

    let chosen: any = null;
    for (const iface of cfg.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === USB_CLASS_CDC_COMM) this.commIfaceNumber = iface.interfaceNumber;
        const hasIn = alt.endpoints.some((e: any) => e.direction === "in" && e.type === "bulk");
        const hasOut = alt.endpoints.some((e: any) => e.direction === "out" && e.type === "bulk");
        if (!hasIn || !hasOut) continue;
        // A CDC data interface is the right one on a composite device; a
        // vendor bridge has exactly one candidate anyway.
        const isData = alt.interfaceClass === USB_CLASS_CDC_DATA;
        if (!chosen || isData) chosen = { iface, alt, isData };
        if (isData) break;
      }
    }
    if (!chosen) throw new Error("This USB device has no bulk serial endpoints.");

    this.ifaceNumber = chosen.iface.interfaceNumber;
    const inEp = chosen.alt.endpoints.find((e: any) => e.direction === "in" && e.type === "bulk");
    const outEp = chosen.alt.endpoints.find((e: any) => e.direction === "out" && e.type === "bulk");
    this.epIn = inEp.endpointNumber;
    this.epOut = outEp.endpointNumber;
    // Needed to find FTDI's per-packet status bytes, which sit at every packet
    // boundary rather than only at the start of a transfer.
    this.epInPacketSize = inEp.packetSize || 64;
  }

  private async controlOut(request: number, value: number, index: number, data?: BufferSource): Promise<void> {
    await this.device.controlTransferOut(
      { requestType: "vendor", recipient: "device", request, value, index },
      data
    );
  }

  private async configure(baudRate: number): Promise<void> {
    switch (this.kind) {
      case "cdc": {
        // SET_LINE_CODING: baud LE32, 1 stop bit, no parity, 8 data bits.
        const d = new DataView(new ArrayBuffer(7));
        d.setUint32(0, baudRate, true);
        d.setUint8(4, 0); d.setUint8(5, 0); d.setUint8(6, 8);
        await this.device.controlTransferOut(
          { requestType: "class", recipient: "interface", request: 0x20, value: 0,
            index: this.commIfaceNumber ?? this.ifaceNumber },
          d.buffer
        );
        break;
      }
      case "ch34x": {
        await this.controlOut(0xa1, 0, 0);                    // serial init
        await this.controlOut(0x9a, 0x1312, ch34xDivisor(baudRate));
        await this.controlOut(0x9a, 0x2518, 0xc3);            // LCR: 8N1, tx+rx on
        await this.controlOut(0xa1, 0x501f, 0xd90a);          // flow control off
        break;
      }
      case "cp210x": {
        await this.ifaceRequest(0x00, 0x0001);                // IFC_ENABLE
        await this.device.controlTransferOut(
          { requestType: "vendor", recipient: "interface", request: 0x1e, value: 0, index: this.ifaceNumber },
          new Uint32Array([baudRate]).buffer                  // SET_BAUDRATE
        );
        await this.ifaceRequest(0x03, 0x0800);                // SET_LINE_CTL: 8N1
        break;
      }
      case "ftdi": {
        const port = this.ifaceNumber + 1;
        await this.controlOut(0x00, 0x0000, port);                        // SIO_RESET
        await this.controlOut(0x03, ftdiDivisor(baudRate), port);         // baud
        await this.controlOut(0x04, 0x0008, port);                        // 8N1
        // Latency timer defaults to 16ms, which makes a request/response
        // protocol crawl. 1ms is what ftdi_sio uses for interactive work.
        await this.controlOut(0x09, 0x0001, port);
        // Throw away whatever is already sitting in the chip's buffers. An
        // FTDI bridge holds bytes across opens, so the first thing a reader
        // saw was the previous sketch's output — and a single stray byte ahead
        // of a bootloader reply is enough to break the handshake.
        await this.controlOut(0x00, 0x0001, port);                        // purge RX
        await this.controlOut(0x00, 0x0002, port);                        // purge TX
        break;
      }
    }
  }

  private async ifaceRequest(request: number, value: number): Promise<void> {
    await this.device.controlTransferOut(
      { requestType: "vendor", recipient: "interface", request, value, index: this.ifaceNumber }
    );
  }

  /**
   * Drive the auto-reset line. This is the whole reason a bridge driver is
   * needed at all: pulsing DTR is what drops an Arduino into its bootloader.
   */
  async setSignals({ dataTerminalReady, requestToSend }: Signals): Promise<void> {
    if (dataTerminalReady !== undefined) this.dtr = dataTerminalReady;
    if (requestToSend !== undefined) this.rts = requestToSend;

    switch (this.kind) {
      case "cdc": {
        const bits = (this.dtr ? 0x01 : 0) | (this.rts ? 0x02 : 0);
        await this.device.controlTransferOut({
          requestType: "class", recipient: "interface", request: 0x22,
          value: bits, index: this.commIfaceNumber ?? this.ifaceNumber,
        });
        break;
      }
      case "ch34x": {
        // ch341.c: bit 5 is DTR, bit 6 is RTS, and the register is inverted.
        const control = (this.dtr ? 1 << 5 : 0) | (this.rts ? 1 << 6 : 0);
        await this.controlOut(0xa4, ~control & 0xffff, 0);
        break;
      }
      case "cp210x": {
        // SET_MHS: high byte is the write mask, low byte the values.
        const value = (0x0300) | (this.dtr ? 0x01 : 0) | (this.rts ? 0x02 : 0);
        await this.ifaceRequest(0x07, value);
        break;
      }
      case "ftdi": {
        await this.controlOut(0x01, this.dtr ? 0x0101 : 0x0100, this.ifaceNumber + 1);
        await this.controlOut(0x01, this.rts ? 0x0202 : 0x0200, this.ifaceNumber + 1);
        break;
      }
    }
  }

  private startPump(): void {
    this.pumping = true;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        const loop = async () => {
          while (this.pumping) {
            let result: any;
            try {
              result = await this.device.transferIn(this.epIn, 64);
            } catch {
              break; // device unplugged or the transfer was cancelled
            }
            if (!this.pumping) break;
            if (result?.status === "stall") {
              try { await this.device.clearHalt("in", this.epIn); } catch { break; }
              continue;
            }
            const view = result?.data;
            if (view && view.byteLength > 0) {
              let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
              if (this.rawLog.length < 6) {
                this.rawLog.push(
                  `len=${bytes.length} [${Array.from(bytes.slice(0, 16))
                    .map((b) => b.toString(16).padStart(2, "0")).join(" ")}]`
                );
              }
              // FTDI prefixes EVERY packet with two modem-status bytes. Passing
              // them through would corrupt the very first protocol reply.
              if (this.kind === "ftdi") {
                // Two modem-status bytes per USB PACKET, not per transfer. A
                // single transferIn can return several coalesced packets, and
                // stripping only the leading pair let the headers buried at
                // each packet boundary leak into the data stream.
                const pkt = this.epInPacketSize || 64;
                const kept: number[] = [];
                for (let off = 0; off < bytes.length; off += pkt) {
                  const end = Math.min(off + pkt, bytes.length);
                  for (let i = off + 2; i < end; i++) kept.push(bytes[i]);
                }
                if (kept.length === 0) continue;
                bytes = new Uint8Array(kept);
              }
              try { controller.enqueue(new Uint8Array(bytes)); } catch { break; }
            }
          }
          try { controller.close(); } catch { /* already closed */ }
        };
        void loop();
      },
      cancel: () => { this.pumping = false; },
    });
  }

  async close(): Promise<void> {
    if (!this.readable && !this.device.opened) throw new Error("The port is not open.");
    this.pumping = false;
    try { this.controller?.close(); } catch { /* already closed */ }
    this.controller = null;
    this.readable = null;
    this.writable = null;
    try { await this.device.releaseInterface(this.ifaceNumber); } catch { /* already released */ }
    if (this.commIfaceNumber !== null && this.commIfaceNumber !== this.ifaceNumber) {
      try { await this.device.releaseInterface(this.commIfaceNumber); } catch { /* not claimed */ }
    }
    try { await this.device.close(); } catch { /* already closed */ }
  }
}

/**
 * CH340/CH341 baud register, transcribed from ch341_get_divisor() in the Linux
 * driver (ch341.c). Returns the 16-bit value written to the combined
 * prescaler/divisor register, including bit 7 which tells the chip both halves
 * are in this one write.
 *
 * An older formula (CH341_BAUDBASE_FACTOR / baud) is widely copied around the
 * web and does NOT agree with current silicon; getting this wrong means the
 * bridge runs at the wrong baud and every byte is garbage.
 */
export function ch34xDivisor(baud: number): number {
  const CLKRATE = 48000000;
  const clkDiv = (ps: number, fact: number) => 1 << (12 - 3 * ps - fact);
  const minRate = (ps: number) => CLKRATE / (clkDiv(ps, 1) * 512);

  let ps = 3;
  for (; ps >= 0; ps--) if (baud > minRate(ps)) break;
  if (ps < 0) throw new Error(`The CH340 cannot do ${baud} baud.`);

  let fact = 1;
  let div = Math.floor(CLKRATE / (clkDiv(ps, fact) * baud));
  if (div < 9 || div > 255) { div = Math.floor(div / 8); fact = 0; }
  if (div < 2) throw new Error(`The CH340 cannot do ${baud} baud.`);

  return (((0x100 - div) << 8) | (fact << 2) | ps | 0x80) & 0xffff;
}

/** ftdi_sio.c divisor encoding for the 3MHz-base parts (FT232R and friends). */
export function ftdiDivisor(baud: number): number {
  const SUB = [0, 3, 2, 4, 1, 5, 6, 7]; // eighths -> encoded sub-divisor
  const base = 3000000;
  // Truncate, do not round: 24000000/57600 is 416.67 and the published
  // divisor for 57600 is 0x0034 (416), not 0xC034 (417).
  const scaled = Math.floor((base * 8) / baud);   // divisor in eighths
  const whole = scaled >> 3;
  const frac = SUB[scaled & 7];
  let value = (whole & 0x3fff) | (frac << 14);
  if (whole === 1 && frac === 0) value = 0;       // 3M baud
  return value & 0xffff;
}

/** What the browser can currently see, for diagnosing an empty picker. */
export async function describeVisibleUsbDevices(): Promise<string> {
  if (!isWebUsbAvailable()) return "WebUSB is not available in this browser.";
  try {
    const devices: any[] = await (navigator as any).usb.getDevices();
    if (!devices.length) return "No USB devices have been authorised yet.";
    return devices
      .map((d) => `0x${d.vendorId.toString(16).padStart(4, "0")}:0x${d.productId.toString(16).padStart(4, "0")}${driverFor(d) ? "" : " (no driver)"}`)
      .join(", ");
  } catch {
    return "Could not enumerate USB devices.";
  }
}

/**
 * Ask the user to pick a board, then wrap it in the Web Serial surface.
 *
 * Shows EVERY device the phone can see, then validates the choice afterwards
 * where we can say something useful about it. A vendor-id list is never
 * complete, and a filter that misses your bridge gives Chrome's "No compatible
 * devices found" over an empty chooser — indistinguishable from nothing being
 * plugged in.
 *
 * The magic spelling is `filters: [{}]`. Note:
 *   - `acceptAllDevices` is a WEB BLUETOOTH option. WebUSB does not have it and
 *     silently ignores it (verified against Chrome).
 *   - `filters: []` — an EMPTY LIST — matches nothing, because the chooser
 *     shows devices matching ANY filter and there are none. That is the exact
 *     bug this replaces.
 *   - `filters: [{}]` — one filter with no constraints — matches everything,
 *     since the spec's match algorithm only tests fields that are present.
 */
export async function requestUsbSerialPort(): Promise<WebUsbSerialPort> {
  let device: any;
  try {
    device = await (navigator as any).usb.requestDevice({ filters: [{}] });
  } catch (e: any) {
    // A build that rejects a property-less filter still gets a usable chooser.
    if (e?.name === "TypeError") {
      device = await (navigator as any).usb.requestDevice({ filters: USB_DEVICE_FILTERS });
    } else if (e?.name === "NotFoundError") {
      throw new Error(
        "No USB device was selected. If the list was EMPTY, the phone is not exposing the board to the " +
        "browser. Three causes, in order of likelihood: the OTG adapter or cable is power-only rather " +
        "than data; the phone is not supplying enough current (a Mega draws more than an ESP32 devkit); " +
        "or Android's own USB-serial driver has already claimed the bridge chip, which puts it out of " +
        "WebUSB's reach entirely."
      );
    } else {
      throw e;
    }
  }
  const kind = driverFor(device);
  if (!kind) {
    const id = `0x${device.vendorId.toString(16).padStart(4, "0")}:0x${device.productId.toString(16).padStart(4, "0")}`;
    throw new Error(
      `That device (${id}) does not present a USB-serial interface this platform can drive. ` +
      `Supported bridges are CDC-ACM (genuine Arduino, native-USB ESP32), CH340, CP210x and FTDI.`
    );
  }
  return new WebUsbSerialPort(device, kind);
}

/** Any device already authorised in a previous session. */
export async function getGrantedUsbSerialPorts(): Promise<WebUsbSerialPort[]> {
  if (!isWebUsbAvailable()) return [];
  const devices: any[] = await (navigator as any).usb.getDevices();
  const out: WebUsbSerialPort[] = [];
  for (const d of devices) {
    const kind = driverFor(d);
    if (kind) out.push(new WebUsbSerialPort(d, kind));
  }
  return out;
}
