/**
 * A simulated AVR chip (avr8js): the CPU and the peripherals an Arduino
 * sketch uses, wired as on the real ATmega328P (Uno, Nano) or ATmega2560
 * (Mega). avr8js describes the 328P itself; the 2560's interrupt vectors,
 * extra timers, serial ports and pin-change groups are set here from the
 * chip's own header (avr-libc iomxx0_1.h) and datasheet.
 */
import {
  CPU, avrInstruction, AVRTimer, timer0Config, timer1Config, timer2Config, AVRIOPort,
  portAConfig, portBConfig, portCConfig, portDConfig, portEConfig, portFConfig, portGConfig,
  portHConfig, portJConfig, portKConfig, portLConfig, INT0, INT1, PCINT0, PCINT1, PCINT2,
  AVRUSART, usart0Config, AVRADC, adcConfig, ADCMuxInputType, AVRTWI, twiConfig, AVRSPI, spiConfig,
  AVREEPROM, EEPROMMemoryBackend, eepromConfig, AVRWatchdog, watchdogConfig, AVRClock, clockConfig,
} from "avr8js";
import type { AVRTimerConfig, AVRPortConfig, ADCConfig, ADCMuxConfiguration } from "avr8js";
import type { BoardDef, Chip } from "./boards";

/** avr8js's USART settings (the type isn't exported). */
type USARTConfig = typeof usart0Config;

export const CLOCK_HZ = 16_000_000;

/** An interrupt vector's number, as avr8js addresses it (in words, two per vector). */
const vec = (n: number) => n * 2;

// ---- ATmega2560 ----

const ext = (index: number, EICR: number, iscOffset: number, vector: number) => ({ EICR, EIMSK: 0x3d, EIFR: 0x3c, index, iscOffset, interrupt: vec(vector) });
const M_INT = [ext(0, 0x69, 0, 1), ext(1, 0x69, 2, 2), ext(2, 0x69, 4, 3), ext(3, 0x69, 6, 4), ext(4, 0x6a, 0, 5), ext(5, 0x6a, 2, 6), ext(6, 0x6a, 4, 7), ext(7, 0x6a, 6, 8)];
const M_PCINT0 = { ...PCINT0, pinChangeInterrupt: vec(9) };
// PCINT8 is PE0; PCINT9-15 are PJ0-PJ6, all on PCMSK1.
const M_PCINT1_E = { ...PCINT1, pinChangeInterrupt: vec(10), mask: 0x01, offset: 0 };
const M_PCINT1_J = { ...PCINT1, pinChangeInterrupt: vec(10), mask: 0x7f, offset: 1 };
const M_PCINT2 = { ...PCINT2, pinChangeInterrupt: vec(11) };

const MEGA_PORTS: Record<string, AVRPortConfig> = {
  A: portAConfig,
  B: { ...portBConfig, pinChange: M_PCINT0, externalInterrupts: [] },
  C: { ...portCConfig, pinChange: undefined, externalInterrupts: [] },
  D: { ...portDConfig, pinChange: undefined, externalInterrupts: [M_INT[0], M_INT[1], M_INT[2], M_INT[3]] },
  E: { ...portEConfig, pinChange: M_PCINT1_E, externalInterrupts: [null, null, null, null, M_INT[4], M_INT[5], M_INT[6], M_INT[7]] },
  F: portFConfig,
  G: portGConfig,
  H: portHConfig,
  J: { ...portJConfig, pinChange: M_PCINT1_J, externalInterrupts: [] },
  K: { ...portKConfig, pinChange: M_PCINT2, externalInterrupts: [] },
  L: portLConfig,
};

const PORT = (letter: string) => MEGA_PORTS[letter].PORT;

const megaTimer16 = (regs: { TIFR: number; TCCRA: number; TCNT: number; ICR: number; OCRA: number; OCRB: number; OCRC: number; TIMSK: number },
  vectors: [number, number, number, number, number], outputs: [string, number][], clockPin: [string, number]): AVRTimerConfig => ({
  ...timer1Config,
  ...regs,
  TCCRB: regs.TCCRA + 1,
  TCCRC: regs.TCCRA + 2,
  captureInterrupt: vec(vectors[0]), compAInterrupt: vec(vectors[1]), compBInterrupt: vec(vectors[2]), compCInterrupt: vec(vectors[3]), ovfInterrupt: vec(vectors[4]),
  compPortA: PORT(outputs[0][0]), compPinA: outputs[0][1],
  compPortB: PORT(outputs[1][0]), compPinB: outputs[1][1],
  compPortC: PORT(outputs[2][0]), compPinC: outputs[2][1],
  externalClockPort: PORT(clockPin[0]), externalClockPin: clockPin[1],
});

const MEGA_TIMERS: AVRTimerConfig[] = [
  { ...timer0Config, compAInterrupt: vec(21), compBInterrupt: vec(22), ovfInterrupt: vec(23), compPortA: PORT("B"), compPinA: 7, compPortB: PORT("G"), compPinB: 5, externalClockPort: PORT("D"), externalClockPin: 7 },
  { ...timer1Config, captureInterrupt: vec(16), compAInterrupt: vec(17), compBInterrupt: vec(18), compCInterrupt: vec(19), ovfInterrupt: vec(20), OCRC: 0x8c,
    compPortA: PORT("B"), compPinA: 5, compPortB: PORT("B"), compPinB: 6, compPortC: PORT("B"), compPinC: 7, externalClockPort: PORT("D"), externalClockPin: 6 },
  { ...timer2Config, compAInterrupt: vec(13), compBInterrupt: vec(14), ovfInterrupt: vec(15), compPortA: PORT("B"), compPinA: 4, compPortB: PORT("H"), compPinB: 6 },
  megaTimer16({ TIFR: 0x38, TCCRA: 0x90, TCNT: 0x94, ICR: 0x96, OCRA: 0x98, OCRB: 0x9a, OCRC: 0x9c, TIMSK: 0x71 }, [31, 32, 33, 34, 35], [["E", 3], ["E", 4], ["E", 5]], ["E", 6]),
  megaTimer16({ TIFR: 0x39, TCCRA: 0xa0, TCNT: 0xa4, ICR: 0xa6, OCRA: 0xa8, OCRB: 0xaa, OCRC: 0xac, TIMSK: 0x72 }, [41, 42, 43, 44, 45], [["H", 3], ["H", 4], ["H", 5]], ["H", 7]),
  megaTimer16({ TIFR: 0x3a, TCCRA: 0x120, TCNT: 0x124, ICR: 0x126, OCRA: 0x128, OCRB: 0x12a, OCRC: 0x12c, TIMSK: 0x73 }, [46, 47, 48, 49, 50], [["L", 3], ["L", 4], ["L", 5]], ["L", 2]),
];

const usart = (vector: number, UCSRA: number): USARTConfig => ({
  rxCompleteInterrupt: vec(vector), dataRegisterEmptyInterrupt: vec(vector + 1), txCompleteInterrupt: vec(vector + 2),
  UCSRA, UCSRB: UCSRA + 1, UCSRC: UCSRA + 2, UBRRL: UCSRA + 4, UBRRH: UCSRA + 5, UDR: UCSRA + 6,
});
const MEGA_USARTS: USARTConfig[] = [usart(25, 0xc0), usart(36, 0xc8), usart(51, 0xd0), usart(54, 0x130)];

const MEGA_ADC_CHANNELS: ADCMuxConfiguration = { 0x1e: { type: ADCMuxInputType.Constant, voltage: 1.1 }, 0x1f: { type: ADCMuxInputType.Constant, voltage: 0 } };
for (let i = 0; i < 8; i++) {
  MEGA_ADC_CHANNELS[i] = { type: ADCMuxInputType.SingleEnded, channel: i };
  MEGA_ADC_CHANNELS[0x20 + i] = { type: ADCMuxInputType.SingleEnded, channel: 8 + i };
}
const MEGA_ADC: ADCConfig = { ...adcConfig, adcInterrupt: vec(29), numChannels: 16, muxInputMask: 0x3f, muxChannels: MEGA_ADC_CHANNELS };

// ---- ATmega328P: avr8js's own configurations ----

const UNO_PORTS: Record<string, AVRPortConfig> = { B: portBConfig, C: portCConfig, D: { ...portDConfig, externalInterrupts: [null, null, INT0, INT1] } };

export interface Mcu {
  chip: Chip;
  cpu: CPU;
  ports: Record<string, AVRIOPort>;
  /** Serial, Serial1... (the Mega has four). */
  usarts: AVRUSART[];
  adc: AVRADC;
  twi: AVRTWI;
  spi: AVRSPI;
  timers: AVRTimer[];
  eeprom: AVREEPROM;
  /** Runs the program until the CPU's cycle count reaches `cycles`. */
  runUntil(cycles: number): void;
}

/** A chip for `board`, with `program` (bytes from parseIntelHex) in its flash. */
export function createMcu(board: BoardDef, program: Uint8Array): Mcu {
  const mega = board.chip === "atmega2560";
  const words = new Uint16Array(board.flashBytes / 2);
  new Uint8Array(words.buffer).set(program.subarray(0, board.flashBytes));
  // avr8js adds the 256 bytes of registers and I/O itself.
  const cpu = new CPU(words, board.dataBytes - 0x100);

  const portConfigs = mega ? MEGA_PORTS : UNO_PORTS;
  const ports: Record<string, AVRIOPort> = {};
  for (const [letter, config] of Object.entries(portConfigs)) ports[letter] = new AVRIOPort(cpu, config);

  const timers = (mega ? MEGA_TIMERS : [timer0Config, timer1Config, timer2Config]).map((c) => new AVRTimer(cpu, c));
  const usarts = (mega ? MEGA_USARTS : [usart0Config]).map((c) => new AVRUSART(cpu, c, CLOCK_HZ));
  const adc = new AVRADC(cpu, mega ? MEGA_ADC : adcConfig);
  const twi = new AVRTWI(cpu, mega ? { ...twiConfig, twiInterrupt: vec(39) } : twiConfig, CLOCK_HZ);
  const spi = new AVRSPI(cpu, mega ? { ...spiConfig, spiInterrupt: vec(24) } : spiConfig, CLOCK_HZ);
  const eeprom = new AVREEPROM(cpu, new EEPROMMemoryBackend(mega ? 4096 : 1024), mega ? { ...eepromConfig, eepromReadyInterrupt: vec(30) } : eepromConfig);
  const clock = new AVRClock(cpu, CLOCK_HZ, clockConfig);
  new AVRWatchdog(cpu, mega ? { ...watchdogConfig, watchdogInterrupt: vec(12) } : watchdogConfig, clock);

  return {
    chip: board.chip,
    cpu,
    ports,
    usarts,
    adc,
    twi,
    spi,
    timers,
    eeprom,
    runUntil(cycles: number) {
      while (cpu.cycles < cycles) {
        avrInstruction(cpu);
        cpu.tick();
      }
    },
  };
}
