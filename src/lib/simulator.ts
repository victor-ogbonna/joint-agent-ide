import { CPU, avrInstruction, avrInterrupt, timer0Config, AVRTimer, portBConfig, portCConfig, portDConfig, AVRIOPort } from 'avr8js';

let cpu: CPU | null = null;
let timer: AVRTimer | null = null;
let running = false;
let stopFlag = false;

// Basic Intel HEX parser
function parseHex(source: string, target: Uint8Array) {
  const lines = source.split('\n');
  for (const line of lines) {
    if (line[0] === ':') {
      const bytes = line.length / 2 - 1;
      const data = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i++) {
        data[i] = parseInt(line.substring(1 + i * 2, 3 + i * 2), 16);
      }
      const len = data[0];
      const type = data[3];
      if (type === 0) {
        const addr = (data[1] << 8) | data[2];
        for (let i = 0; i < len; i++) {
          target[addr + i] = data[4 + i];
        }
      }
    }
  }
}

export function startSimulation(hexString: string, onPrint: (text: string) => void) {
  stopFlag = false;
  const program = new Uint16Array(32768);
  parseHex(hexString, new Uint8Array(program.buffer));

  cpu = new CPU(program);
  timer = new AVRTimer(cpu, timer0Config);

  const portB = new AVRIOPort(cpu, portBConfig);
  const portC = new AVRIOPort(cpu, portCConfig);
  const portD = new AVRIOPort(cpu, portDConfig);

  // Hook up USART to onPrint (UDR0 is at 0xC6)
  cpu.writeHooks[0xc6] = (value: number) => {
    onPrint(String.fromCharCode(value));
  };

  running = true;
  
  // Use a proper simulator loop
  function executeCycle() {
    if (!running || !cpu || stopFlag) return;
    for (let i = 0; i < 500000; i++) {
      avrInstruction(cpu);
      cpu.tick();
    }
    requestAnimationFrame(executeCycle);
  }

  requestAnimationFrame(executeCycle);
  return { cpu, portB, portC, portD };
}

export function stopSimulation() {
  stopFlag = true;
  running = false;
  cpu = null;
  timer = null;
}
