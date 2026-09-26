
export type MCUType = 'esp32' | 'arduino';

// Mirrors server/boards.ts's BoardInfo — one entry per board returned by GET /api/boards.
export interface BoardInfo {
  id: string;
  name: string;
  mcu: string;
  fcpu: number;
  ram: number;
  rom: number;
  vendor: string;
  platform: string;
  family: MCUType;
}
export interface SchematicComponent {
  id: string;
  type: "led" | "resistor" | "dht11" | "servo" | "lcd" | "button" | "relay" | "buzzer" | "potentiometer" | "pir" | "neopixel" | "ultrasonic" | "arduino" | "esp32" | "keypad" | "oled" | "rgb" | "switch" | "7segment" | "joystick";
  label: string;
  value?: string;
  x?: number;
  y?: number;
  rotation?: number;
  pins?: ComponentPin[] | number;
}

export interface SchematicConnection {
  id: string;
  fromComponentId: string;
  fromPin: string;
  toComponentId: string;
  toPin: string;
  color: string;
  /** Bend points the user clicked while tracing this wire, in canvas space. */
  waypoints?: { x: number; y: number }[];
}

export interface ComponentPin {
  name: string;
  type: "digital" | "analog" | "power" | "gnd" | "i2c" | "spi";
  x: number;
  y: number;
}

export interface TerminalLine {
  text: string;
  type: "info" | "error" | "success" | "warning" | "serial" | "input";
  id?: string;
  timestamp: string;
}

export interface Web3WalletState {
  connected: boolean;
  address: string | null;
  chainId: string | null;
  balance: string | null;
  authenticating: boolean;
  authenticated: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  suggestions?: string[];
  isPlanResponse?: boolean;
  /** The agent's summary of everything before it, made when the conversation
   *  filled its context budget. Sent to the model in place of those messages. */
  isContextSummary?: boolean;
  /** Folded into a summary: still shown, no longer sent to the model. */
  compacted?: boolean;
  suggestedProjectUpdate?: {
    code?: string;
    description?: string;
    components?: SchematicComponent[];
    connections?: SchematicConnection[];
  };
}
