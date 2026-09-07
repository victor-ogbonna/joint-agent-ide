import React, { useState, useEffect, useRef, useCallback } from "react";
import { Cpu, Activity, Square, Monitor, Bell, Lightbulb, ToggleLeft, MousePointer2, Layers, Zap, ZoomIn, ZoomOut, RotateCcw, RotateCw, Plus, Trash2, Edit2, Check, RefreshCw, Undo2, Redo2 } from "lucide-react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import { SchematicComponent, SchematicConnection, ComponentPin } from "../types";
import "@wokwi/elements";

interface SchematicViewerProps {
  mcu: string;
  components: SchematicComponent[];
  connections: SchematicConnection[];
  isSimulationActive?: boolean;
  onSimulate?: () => void;
  isCompiling?: boolean;
  isFlashing?: boolean;
  appMode?: "agentic" | "manual";
  setComponents?: React.Dispatch<React.SetStateAction<SchematicComponent[]>>;
  setConnections?: React.Dispatch<React.SetStateAction<SchematicConnection[]>>;
}

const WIRE_COLORS = [
  "#ef4444", "#3b82f6", "#22c55e", "#eab308", "#f97316",
  "#a855f7", "#06b6d4", "#ffffff", "#18181b", "#71717a"
];

// The AI (and the user) may refer to the microcontroller board itself using
// any of these IDs — treat them all as the same virtual "mcu" wiring target.
const isMcuRef = (id: string | null | undefined) =>
  !!id && ["mcu", "esp32", "arduino", "board", "uno"].includes(id.toLowerCase());

// Hand-calibrated pin positions against the real wokwi-esp32-devkit-v1 /
// wokwi-arduino-uno renders (tools/pin-calibrator.html), at the exact render
// scale boardConfig.scale applies below (2.0x / 1.3x) — coordinates are local
// offsets from the board's own top-left corner.
const ESP32_PIN_OFFSETS: Record<string, { x: number; y: number }> = {
  "3V3": { x: 100, y: 160 }, "EN": { x: 5, y: 25 }, "VP": { x: 5, y: 35 }, "VN": { x: 5, y: 45 },
  "34": { x: 5, y: 55 }, "35": { x: 5, y: 65 }, "32": { x: 5, y: 75 }, "33": { x: 5, y: 85 },
  "25": { x: 5, y: 95 }, "26": { x: 5, y: 105 }, "27": { x: 5, y: 115 }, "14": { x: 5, y: 125 },
  "12": { x: 5, y: 135 }, "13": { x: 5, y: 145 }, "GND": { x: 5, y: 155 }, "VIN": { x: 5, y: 165 },
  "D23": { x: 100, y: 25 }, "D22": { x: 100, y: 35 }, "TX0": { x: 100, y: 45 }, "RX0": { x: 100, y: 55 },
  "D21": { x: 100, y: 65 }, "D19": { x: 100, y: 75 }, "D18": { x: 100, y: 85 }, "D5": { x: 100, y: 95 },
  "TX2": { x: 100, y: 100 }, "RX2": { x: 100, y: 110 }, "D4": { x: 100, y: 120 }, "D2": { x: 100, y: 130 },
  "D15": { x: 100, y: 140 },
};
const ARDUINO_PIN_OFFSETS: Record<string, { x: number; y: number }> = {
  "IOREF": { x: 130, y: 195 }, "RESET": { x: 140, y: 195 }, "3V3": { x: 150, y: 195 }, "5V": { x: 160, y: 195 },
  "GND": { x: 170, y: 195 }, "VIN": { x: 190, y: 195 }, "A0": { x: 205, y: 195 }, "A1": { x: 215, y: 195 },
  "A2": { x: 225, y: 195 }, "A3": { x: 235, y: 195 }, "A4": { x: 245, y: 195 }, "A5": { x: 255, y: 195 },
  "D0": { x: 255, y: 10 }, "D1": { x: 245, y: 10 }, "D2": { x: 235, y: 10 }, "D3": { x: 225, y: 10 },
  "D4": { x: 215, y: 10 }, "D5": { x: 205, y: 10 }, "D6": { x: 195, y: 10 }, "D7": { x: 185, y: 10 },
  "D8": { x: 175, y: 10 }, "D9": { x: 165, y: 10 }, "D10": { x: 155, y: 10 }, "D11": { x: 145, y: 10 },
  "D12": { x: 135, y: 10 }, "D13": { x: 125, y: 10 }, "AREF": { x: 105, y: 10 }, "SDA": { x: 95, y: 10 },
  "SCL": { x: 85, y: 10 },
};

// Coordinates below (except relay/neopixel/oled, which have no working visual
// yet — see renderComponentBody) were hand-calibrated against the real Wokwi
// element renders using tools/pin-calibrator.html, at the same render scale
// SchematicViewer applies (1.5x for these small parts, 1.0x for the LCD).
const getPinsForType = (type: string): ComponentPin[] => {
  switch (type) {
    case "led": return [{ name: "anode", type: "digital", x: 40, y: 60 }, { name: "cathode", type: "gnd", x: 20, y: 60 }];
    case "resistor": return [{ name: "pin1", type: "analog", x: 0, y: 10 }, { name: "pin2", type: "analog", x: 90, y: 10 }];
    case "dht11": return [{ name: "VCC", type: "power", x: 15, y: 115 }, { name: "DATA", type: "digital", x: 25, y: 115 }, { name: "GND", type: "gnd", x: 45, y: 115 }];
    case "servo": return [{ name: "GND", type: "gnd", x: 5, y: 50 }, { name: "VCC", type: "power", x: 5, y: 60 }, { name: "PWM", type: "digital", x: 5, y: 70 }];
    case "lcd": return [{ name: "VCC", type: "power", x: 295, y: 25 }, { name: "GND", type: "gnd", x: 295, y: 35 }, { name: "SDA", type: "i2c", x: 295, y: 45 }, { name: "SCL", type: "i2c", x: 295, y: 55 }];
    case "button": return [{ name: "pin1", type: "digital", x: 5, y: 20 }, { name: "pin2", type: "digital", x: 95, y: 20 }];
    case "relay": return [{ name: "VCC", type: "power", x: 10, y: 30 }, { name: "GND", type: "gnd", x: 30, y: 30 }, { name: "IN", type: "digital", x: 50, y: 30 }, { name: "NO", type: "digital", x: 10, y: 0 }, { name: "COM", type: "digital", x: 30, y: 0 }, { name: "NC", type: "digital", x: 50, y: 0 }];
    case "buzzer": return [{ name: "VCC", type: "power", x: 55, y: 135 }, { name: "GND", type: "gnd", x: 40, y: 135 }];
    case "potentiometer": return [{ name: "GND", type: "gnd", x: 30, y: 70 }, { name: "SIG", type: "analog", x: 40, y: 70 }, { name: "VCC", type: "power", x: 50, y: 70 }];
    case "pir": return [{ name: "VCC", type: "power", x: 35, y: 90 }, { name: "OUT", type: "digital", x: 45, y: 90 }, { name: "GND", type: "gnd", x: 55, y: 90 }];
    case "neopixel": return [{ name: "VDD", type: "power", x: 10, y: 40 }, { name: "DIN", type: "digital", x: 30, y: 40 }, { name: "DOUT", type: "digital", x: 50, y: 40 }, { name: "GND", type: "gnd", x: 70, y: 40 }];
    case "ultrasonic": return [{ name: "VCC", type: "power", x: 70, y: 95 }, { name: "TRIG", type: "digital", x: 80, y: 95 }, { name: "ECHO", type: "digital", x: 90, y: 95 }, { name: "GND", type: "gnd", x: 100, y: 95 }];
    case "arduino": return [{ name: "5V", type: "power", x: 40, y: 80 }, { name: "GND", type: "gnd", x: 60, y: 80 }, { name: "D13", type: "digital", x: 80, y: 10 }];
    case "esp32": return [{ name: "3V3", type: "power", x: 10, y: 20 }, { name: "GND", type: "gnd", x: 10, y: 40 }, { name: "D2", type: "digital", x: 100, y: 20 }];
    case "keypad": return [{ name: "R1", type: "digital", x: 50, y: 265 }, { name: "R2", type: "digital", x: 60, y: 265 }, { name: "R3", type: "digital", x: 70, y: 265 }, { name: "R4", type: "digital", x: 80, y: 265 }, { name: "C1", type: "digital", x: 90, y: 265 }, { name: "C2", type: "digital", x: 100, y: 265 }, { name: "C3", type: "digital", x: 110, y: 265 }, { name: "C4", type: "digital", x: 120, y: 265 }];
    case "oled": return [{ name: "VCC", type: "power", x: 10, y: 40 }, { name: "GND", type: "gnd", x: 30, y: 40 }, { name: "SCL", type: "i2c", x: 50, y: 40 }, { name: "SDA", type: "i2c", x: 70, y: 40 }];
    case "rgb": return [{ name: "R", type: "digital", x: 10, y: 40 }, { name: "COM", type: "gnd", x: 15, y: 55 }, { name: "G", type: "digital", x: 25, y: 45 }, { name: "B", type: "digital", x: 35, y: 45 }];
    case "switch": return [{ name: "pin1", type: "digital", x: 5, y: 35 }, { name: "common", type: "digital", x: 15, y: 35 }, { name: "pin2", type: "digital", x: 25, y: 35 }];
    case "7segment": return [{ name: "a", type: "digital", x: 5, y: 5 }, { name: "b", type: "digital", x: 15, y: 5 }, { name: "c", type: "digital", x: 25, y: 5 }, { name: "d", type: "digital", x: 35, y: 5 }, { name: "e", type: "digital", x: 45, y: 5 }, { name: "f", type: "digital", x: 5, y: 70 }, { name: "g", type: "digital", x: 15, y: 70 }, { name: "dp", type: "digital", x: 25, y: 70 }, { name: "com1", type: "gnd", x: 35, y: 70 }, { name: "com2", type: "gnd", x: 45, y: 70 }];
    case "joystick": return [{ name: "GND", type: "gnd", x: 70, y: 115 }, { name: "VCC", type: "power", x: 30, y: 115 }, { name: "VRX", type: "analog", x: 50, y: 115 }, { name: "VRY", type: "analog", x: 40, y: 115 }, { name: "SW", type: "digital", x: 60, y: 115 }];
    default: return [{ name: "pin1", type: "digital", x: 10, y: 10 }, { name: "pin2", type: "gnd", x: 30, y: 10 }];
  }
};

const AVAILABLE_COMPONENTS = [
  { type: "led", label: "LED" },
  { type: "resistor", label: "Resistor" },
  { type: "button", label: "Button" },
  { type: "servo", label: "Servo" },
  { type: "dht11", label: "DHT11" },
  { type: "lcd", label: "LCD" },
  { type: "pir", label: "PIR" },
  { type: "neopixel", label: "NeoPx" },
  { type: "ultrasonic", label: "Sonar" },
  { type: "arduino", label: "Uno" },
  { type: "esp32", label: "ESP32" },

  { id: 'relay', type: 'relay', label: 'Relay Module', icon: Cpu, desc: 'Controls high-voltage devices', pins: 3 },
  { id: 'potentiometer', type: 'potentiometer', label: 'Potentiometer', icon: Activity, desc: 'Variable resistor (analog)', pins: 3 },
  { id: 'keypad', type: 'keypad', label: 'Membrane Keypad', icon: Square, desc: '4x4 button matrix', pins: 8 },
  { id: 'oled', type: 'oled', label: 'OLED Display', icon: Monitor, desc: '128x64 SSD1306', pins: 4 },
  { id: 'buzzer', type: 'buzzer', label: 'Piezo Buzzer', icon: Bell, desc: 'Creates simple tones', pins: 2 },
  { id: 'rgb', type: 'rgb', label: 'RGB LED', icon: Lightbulb, desc: 'Multi-color LED', pins: 4 },
  { id: 'switch', type: 'switch', label: 'Slide Switch', icon: ToggleLeft, desc: 'SPDT Slide Switch', pins: 3 },
  { id: '7segment', type: '7segment', label: '7-Segment Display', icon: Monitor, desc: 'Classic digital digit', pins: 10 },
  { id: 'joystick', type: 'joystick', label: 'Analog Joystick', icon: MousePointer2, desc: 'X/Y axis + button', pins: 5 },
];

// Shown for component types without a working visual yet (e.g. relay,
// neopixel, oled) so the schematic stays honest instead of rendering blank.
function ComingSoonPlaceholder({ width, height, label }: { width: number; height: number; label?: string }) {
  return (
    <div
      style={{ width, height }}
      className="flex flex-col items-center justify-center gap-0.5 rounded-md border-2 border-dashed border-[var(--border-main)] bg-[var(--bg-surface)]/60 text-center px-1"
    >
      <span className="text-[8px] font-bold uppercase tracking-wide text-[var(--text-muted)] leading-tight">Coming Soon</span>
      {label && <span className="text-[7px] text-[var(--text-subtle)] truncate max-w-full leading-tight">{label}</span>}
    </div>
  );
}

// Module-level (not tied to the live/editable viewer) so both the real
// workspace and the disabled "coming soon" palette preview can render the
// same real Wokwi component art.
function renderComponentBody(comp: SchematicComponent, isSimulationActive: boolean, footprintW?: number, footprintH?: number) {
  const rotation = comp.rotation || 0;
  const transformStyle = { transform: `scale(${comp.type === 'lcd' || comp.type === 'arduino' || comp.type === 'esp32' ? 1.0 : 1.5}) rotate(${rotation}deg)`, transformOrigin: 'top left', pointerEvents: 'none' as const };
  const comingSoon = <ComingSoonPlaceholder width={footprintW || 70} height={footprintH || 70} label={comp.label} />;
  switch (comp.type) {
    case "led": return React.createElement("wokwi-led", { color: "red", value: isSimulationActive ? "1" : "0", style: transformStyle });
    case "resistor": return React.createElement("wokwi-resistor", { value: "220", style: transformStyle });
    case "button": return React.createElement("wokwi-pushbutton", { color: "blue", style: transformStyle });
    case "servo": return React.createElement("wokwi-servo", { style: transformStyle });
    case "dht11": return React.createElement("wokwi-dht22", { style: transformStyle });
    case "lcd": return React.createElement("wokwi-lcd1602", { style: transformStyle });
    case "relay": return comingSoon;
    case "buzzer": return React.createElement("wokwi-buzzer", { style: transformStyle });
    case "potentiometer": return React.createElement("wokwi-potentiometer", { style: transformStyle });
    case "pir": return React.createElement("wokwi-pir-motion-sensor", { style: transformStyle });
    case "neopixel": return comingSoon;
    case "ultrasonic": return React.createElement("wokwi-hc-sr04", { style: transformStyle });
    case "arduino": return React.createElement("wokwi-arduino-uno", { style: transformStyle });
    case "esp32": return React.createElement("wokwi-esp32-devkit-v1", { style: transformStyle });
    case "keypad": return React.createElement("wokwi-membrane-keypad", { style: transformStyle });
    case "oled": return comingSoon;
    case "rgb": return React.createElement("wokwi-rgb-led", { style: transformStyle });
    case "switch": return React.createElement("wokwi-slide-switch", { style: transformStyle });
    case "7segment": return React.createElement("wokwi-7segment", { style: transformStyle });
    case "joystick": return React.createElement("wokwi-analog-joystick", { style: transformStyle });
    default: return comingSoon;
  }
}

// The schematic workspace (both agent-generated and manual circuit building)
// is paused for now — flip this back to false to re-enable it. Everything
// below stays intact so it can come back with no rework.
const SCHEMATIC_VIEW_COMING_SOON = true;

const SCHEMATIC_GRID_STYLE: React.CSSProperties = {
  backgroundColor: "var(--bg-schematic)",
  backgroundImage: "linear-gradient(color-mix(in srgb, var(--border-main) 60%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border-main) 60%, transparent) 1px, transparent 1px)",
  backgroundSize: "40px 40px"
};

function ComingSoonInscription() {
  return (
    <div className="text-center space-y-3 max-w-xs relative">
      <div
        className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-white shadow-lg animate-pulse"
        style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-glow)" }}
      >
        <Layers size={28} />
      </div>
      <h3 className="font-display font-bold text-lg gradient-text">Coming Soon</h3>
    </div>
  );
}

function SchematicComingSoonPanel({ appMode }: { appMode?: "agentic" | "manual" }) {
  if (appMode === "manual") {
    // Keep the full manual workspace shell in view — header, canvas, and the
    // components sidebar — but the canvas holds only the inscription (no
    // components render there) and the sidebar is visible yet fully inert
    // (pointer-events-none), so nothing can be added to the workspace.
    return (
      <div id="schematic-viewer-panel" className="bg-[var(--bg-panel)] flex flex-col h-full w-full">
        <div className="bg-[var(--bg-panel)] border-b border-[var(--border-main)] px-4 py-2 flex items-center gap-2 shrink-0">
          <div className="p-1.5 bg-blue-500/10 rounded-lg text-blue-400">
            <Layers size={14} />
          </div>
          <h2 className="font-display font-bold text-[10px] text-[var(--text-muted)] tracking-wide uppercase">
            Dynamic Schematic
          </h2>

          {/* Same toolbar as the real workspace, shown for context — every
              button is natively disabled (not just dimmed), so nothing here
              is clickable while schematic editing is still Coming Soon. */}
          <div className="flex items-center gap-2 ml-4 opacity-50 select-none">
            <div className="h-4 w-px bg-[var(--border-main)] mx-2"></div>
            <button disabled className="p-1.5 text-[var(--text-muted)] rounded disabled:opacity-30" title="Undo">
              <Undo2 size={12} />
            </button>
            <button disabled className="p-1.5 text-[var(--text-muted)] rounded disabled:opacity-30" title="Redo">
              <Redo2 size={12} />
            </button>

            <div className="h-4 w-px bg-[var(--border-main)] mx-2"></div>
            <span className="text-[10px] text-[var(--text-muted)]">Wire:</span>
            <div className="flex items-center gap-1">
              {WIRE_COLORS.map(color => (
                <button
                  key={color}
                  disabled
                  className={`w-4 h-4 rounded-full border cursor-default ${color === '#ffffff' ? 'border-black/30 dark:border-black/50' : color === '#18181b' ? 'border-white/40 dark:border-white/30' : 'border-transparent'}`}
                  style={{ backgroundColor: color }}
                  title={color}
                />
              ))}
            </div>

            <div className="h-4 w-px bg-[var(--border-main)] mx-2"></div>
            <button disabled className="p-1.5 text-blue-400 rounded disabled:opacity-30" title="Rotate Left">
              <RotateCcw size={12} />
            </button>
            <button disabled className="p-1.5 text-blue-400 rounded disabled:opacity-30" title="Rotate Right">
              <RotateCw size={12} />
            </button>
            <button disabled className="p-1.5 text-red-400 rounded disabled:opacity-30" title="Remove Selected Component">
              <Trash2 size={12} />
            </button>

            <button disabled className="ml-2 flex items-center gap-1 bg-green-600 text-white text-[10px] font-bold px-2 py-1 rounded disabled:opacity-50">
              <Zap size={10} /> SIMULATE
            </button>
          </div>
        </div>
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 flex items-center justify-center" style={SCHEMATIC_GRID_STYLE}>
            <ComingSoonInscription />
          </div>
          <div className="w-80 bg-[var(--bg-panel)] border-l border-[var(--border-main)] flex flex-col shadow-xl opacity-40 pointer-events-none select-none shrink-0">
            <div className="p-3 border-b border-[var(--border-main)] bg-[var(--bg-root)]">
              <h3 className="text-xs font-bold text-[var(--text-main)] uppercase tracking-wider">Components</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <div className="grid grid-cols-3 gap-2">
                {AVAILABLE_COMPONENTS.map(c => (
                  <div
                    key={c.type}
                    className="p-1.5 border border-[var(--border-main)] rounded bg-[var(--bg-root)] flex flex-col items-center justify-center gap-1.5 aspect-square"
                  >
                    <div className="h-10 w-full flex items-center justify-center opacity-80 overflow-hidden">
                      <div style={{ transform: 'scale(0.5)' }}>
                        {renderComponentBody({ type: c.type as any, rotation: 0 } as SchematicComponent, false)}
                      </div>
                    </div>
                    <span className="text-[9px] font-medium text-[var(--text-main)] text-center leading-tight truncate w-full">{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="schematic-viewer-panel" className="bg-[var(--bg-panel)] flex flex-col h-full w-full">
      <div className="bg-[var(--bg-panel)] border-b border-[var(--border-main)] px-4 py-2 flex items-center gap-2 shrink-0">
        <div className="p-1.5 bg-blue-500/10 rounded-lg text-blue-400">
          <Layers size={14} />
        </div>
        <h2 className="font-display font-bold text-[10px] text-[var(--text-muted)] tracking-wide uppercase">
          Dynamic Schematic
        </h2>
      </div>
      <div className="flex-1 flex items-center justify-center p-8 relative" style={SCHEMATIC_GRID_STYLE}>
        <div className="space-y-3">
          <ComingSoonInscription />
          <p className="text-xs text-[var(--text-muted)] leading-relaxed max-w-xs">
            Automatic circuit schematic generation is being polished and isn't available yet.
          </p>
        </div>
      </div>
    </div>
  );
}

function SchematicViewerImpl({
  mcu,
  components,
  connections,
  isSimulationActive = false,
  onSimulate,
  isCompiling,
  isFlashing,
  appMode = "agentic",
  setComponents,
  setConnections
}: SchematicViewerProps) {
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [wireColor, setWireColor] = useState<string>("#3b82f6");
  const [drawingStart, setDrawingStart] = useState<{ compId: string, pinName: string } | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number, y: number } | null>(null);
  // Bend points the user has clicked so far while tracing the current wire.
  const [waypoints, setWaypoints] = useState<{ x: number, y: number }[]>([]);
  
  const [history, setHistory] = useState<{components: SchematicComponent[], connections: SchematicConnection[]}[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Current canvas zoom level (from TransformWrapper), so drag deltas map
  // 1:1 to canvas-space pixels regardless of how zoomed in/out the view is.
  const zoomScaleRef = useRef(1);

  // Dragging state
  const [draggedCompId, setDraggedCompId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number, y: number }>({ x: 0, y: 0 });

  const saveState = useCallback((newComps: SchematicComponent[], newConns: SchematicConnection[]) => {
    setHistory(prev => {
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push({ components: [...newComps], connections: [...newConns] });
      return newHistory;
    });
    setHistoryIndex(prev => prev + 1);
  }, [historyIndex]);

  // Initial save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (appMode === "manual" && e.key === "Escape" && drawingStart) {
        setDrawingStart(null);
        setWaypoints([]);
        return;
      }
      if (appMode === "manual" && selectedComponentId && (e.key === "Delete" || e.key === "Backspace")) {
        if (isMcuRef(selectedComponentId)) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

        if (setComponents && setConnections) {
          const newComps = components.filter(c => c.id !== selectedComponentId);
          const newConns = connections.filter(c => c.fromComponentId !== selectedComponentId && c.toComponentId !== selectedComponentId);
          setComponents(newComps);
          setConnections(newConns);
          setSelectedComponentId(null);
          saveState(newComps, newConns);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [appMode, selectedComponentId, components, connections, setComponents, setConnections, drawingStart]);

  useEffect(() => {
    if (history.length === 0 && appMode === "manual") {
      saveState(components, connections);
    }
  }, [appMode]);

  const drawWirePath = (startX: number, startY: number, endX: number, endY: number) => {
    const midX = startX + (endX - startX) / 2;
    return `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`;
  };

  // With no waypoints, auto-route a simple orthogonal jog (drawWirePath).
  // With waypoints, draw straight segments through each point the user
  // clicked while tracing — that's a deliberate manual route, so respect it.
  const buildWirePath = (start: { x: number, y: number }, end: { x: number, y: number }, wps?: { x: number, y: number }[]) => {
    if (!wps || wps.length === 0) return drawWirePath(start.x, start.y, end.x, end.y);
    const points = [start, ...wps, end];
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  };

  const mcuOffsets = mcu === "esp32" ? ESP32_PIN_OFFSETS : ARDUINO_PIN_OFFSETS;
  const esp32Pins = ["3V3", "EN", "VP", "VN", "34", "35", "32", "33", "25", "26", "27", "14", "12", "13", "GND", "VIN", "D23", "D22", "TX0", "RX0", "D21", "D19", "D18", "D5", "TX2", "RX2", "D4", "D2", "D15"];
  const arduinoPins = ["IOREF", "RESET", "3V3", "5V", "GND", "VIN", "A0", "A1", "A2", "A3", "A4", "A5", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "AREF", "SDA", "SCL"];
  const mcuPinList = mcu === "esp32" ? esp32Pins : arduinoPins;

  const boardConfig = {
    x: 400,
    y: 100,
    // Footprint derived from the calibrated pin extents, so the hitbox always
    // matches the real rendered board regardless of which board is active.
    width: Math.max(...Object.values(mcuOffsets).map(o => o.x)) + 20,
    height: Math.max(...Object.values(mcuOffsets).map(o => o.y)) + 25,
    scale: mcu === "esp32" ? 2.0 : 1.3,
  };

  // Pin position relative to the board's own top-left corner (local, unrotated).
  const getMcuPinOffset = (pinName: string) => mcuOffsets[pinName] || { x: 10, y: 10 };

  // Absolute canvas position (for wire endpoints).
  const getMcuPinPosition = (pinName: string) => {
    const offset = getMcuPinOffset(pinName);
    return { x: boardConfig.x + offset.x, y: boardConfig.y + offset.y };
  };

  const updateComponents = (newComps: SchematicComponent[]) => {
    if (setComponents) setComponents(newComps);
    saveState(newComps, connections);
  };
  
  const updateConnections = (newConns: SchematicConnection[]) => {
    if (setConnections) setConnections(newConns);
    saveState(components, newConns);
  };

  const handleAddComponent = (type: string, label: string) => {
    if (!setComponents) return;
        let newX = 100;
    let newY = 100;
    let overlapping = true;
    while(overlapping) {
      overlapping = components.some(c => Math.abs((c.x||0) - newX) < 100 && Math.abs((c.y||0) - newY) < 100);
      if(overlapping) {
        newX += 120;
        if (newX > 800) {
          newX = 100;
          newY += 120;
        }
      }
    }

    const newComp: SchematicComponent = {
      id: `comp_${Date.now()}`,
      type: type as any,
      label,
      x: newX,
      y: newY,
      pins: getPinsForType(type),
      rotation: 0
    };
    const newComps = [...components, newComp];
    updateComponents(newComps);
    setSelectedComponentId(newComp.id);
  };

  const handleRemoveComponent = () => {
    if (!setComponents || !selectedComponentId) return;
    const newComps = components.filter(c => c.id !== selectedComponentId);
    const newConns = connections.filter(conn => conn.fromComponentId !== selectedComponentId && conn.toComponentId !== selectedComponentId);
    
    if (setComponents) setComponents(newComps);
    if (setConnections) setConnections(newConns);
    saveState(newComps, newConns);
    setSelectedComponentId(null);
  };

  const handleRotateComponent = (direction: 1 | -1) => {
    if (!setComponents || !selectedComponentId) return;
    const newComps = components.map(c => 
      c.id === selectedComponentId 
        ? { ...c, rotation: ((c.rotation || 0) + (90 * direction) + 360) % 360 }
        : c
    );
    updateComponents(newComps);
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      const state = history[newIndex];
      if (setComponents) setComponents(state.components);
      if (setConnections) setConnections(state.connections);
      setHistoryIndex(newIndex);
      setSelectedComponentId(null);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      const state = history[newIndex];
      if (setComponents) setComponents(state.components);
      if (setConnections) setConnections(state.connections);
      setHistoryIndex(newIndex);
      setSelectedComponentId(null);
    }
  };

  // Starting a wire: either a plain click on a pin (mousedown+mouseup with no
  // movement) or the press-down that begins a drag-to-trace gesture — both
  // funnel through this same handler since it only needs the initial press.
  const handlePinMouseDown = (compId: string, pinName: string) => {
    if (appMode !== "manual" || !setConnections) return;

    if (!drawingStart) {
      setDrawingStart({ compId, pinName });
      setWaypoints([]);
    } else if (drawingStart.compId === compId && drawingStart.pinName === pinName) {
      // Pressing the start pin again cancels the in-progress wire.
      setDrawingStart(null);
      setWaypoints([]);
    }
  };

  // Completing a wire: fires on mouseup over a *different* pin, whether that
  // release ends a drag (cursor dragged straight from the start pin) or is a
  // separate later click (classic click-then-click routing).
  const handlePinMouseUp = (compId: string, pinName: string) => {
    if (appMode !== "manual" || !setConnections || !drawingStart) return;
    if (drawingStart.compId === compId && drawingStart.pinName === pinName) return;

    const newConnection: SchematicConnection = {
      id: `conn_${Date.now()}`,
      fromComponentId: drawingStart.compId,
      fromPin: drawingStart.pinName,
      toComponentId: compId,
      toPin: pinName,
      color: wireColor,
      waypoints: waypoints.length > 0 ? waypoints : undefined
    };
    updateConnections([...connections, newConnection]);
    setDrawingStart(null);
    setWaypoints([]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const svg = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - svg.left;
    const y = e.clientY - svg.top;

    if (drawingStart) {
      setMousePos({ x, y });
    }

    if (draggedCompId && setComponents) {
      // Convert screen-pixel mouse delta to canvas-space delta using the
      // actual current zoom scale, so the component tracks the cursor
      // precisely at any zoom level (not just an approximation).
      const scale = zoomScaleRef.current || 1;
      const dx = (e.clientX - dragOffset.x) / scale;
      const dy = (e.clientY - dragOffset.y) / scale;

      setComponents(prev => prev.map(c =>
        c.id === draggedCompId ? { ...c, x: c.x + dx, y: c.y + dy } : c
      ));
      setDragOffset({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (draggedCompId) {
      // Done dragging, save state
      setDraggedCompId(null);
      saveState(components, connections);
      return;
    }

    // Releasing over open canvas while tracing a wire drops a joint here and
    // keeps tracing — pin mouseups stopPropagation so they never reach this.
    if (appMode === "manual" && drawingStart) {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setWaypoints(prev => [...prev, { x, y }]);
    }
  };

  const getPinPos = (compId: string, pinName: string) => {
    if (isMcuRef(compId)) return getMcuPinPosition(pinName);
    const comp = components.find(c => c.id === compId);
    if (!comp) return { x: 0, y: 0 };
    const pins = Array.isArray(comp.pins) ? comp.pins : []; const pinDef = pins.find(p => p.name === pinName);
    let pinOffsetX = pinDef?.x || 20;
    let pinOffsetY = pinDef?.y || 20;
    
    const rotation = comp.rotation || 0;
    const rad = (rotation * Math.PI) / 180;
    
    const rotX = pinOffsetX * Math.cos(rad) - pinOffsetY * Math.sin(rad);
    const rotY = pinOffsetX * Math.sin(rad) + pinOffsetY * Math.cos(rad);
    
    return {
      x: (comp.x || 0) + rotX,
      y: (comp.y || 0) + rotY
    };
  };

  return (
    <div id="schematic-viewer-panel" className="bg-[var(--bg-panel)] flex flex-col h-full w-full">
      <div className="bg-[var(--bg-panel)] border-b border-[var(--border-main)] px-4 py-2 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-blue-500/10 rounded-lg text-blue-400">
            <Layers size={14} />
          </div>
          <h2 className="font-display font-bold text-[10px] text-[var(--text-muted)] tracking-wide uppercase">
            DYNAMIC SCHEMATIC
          </h2>
          
          {appMode === "manual" && (
            <div className="flex items-center gap-2 ml-4">
              <div className="h-4 w-px bg-[var(--border-main)] mx-2"></div>
              
              <button onClick={handleUndo} disabled={historyIndex <= 0} className="p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)] rounded transition disabled:opacity-30" title="Undo">
                <Undo2 size={12} />
              </button>
              <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)] rounded transition disabled:opacity-30" title="Redo">
                <Redo2 size={12} />
              </button>

              <div className="h-4 w-px bg-[var(--border-main)] mx-2"></div>
              <span className="text-[10px] text-[var(--text-muted)]">Wire:</span>
              <div className="flex items-center gap-1">
                {WIRE_COLORS.map(color => (
                  <button 
                    key={color} 
                    onClick={() => setWireColor(color)}
                    className={`w-4 h-4 rounded-full border ${wireColor === color ? 'scale-110 shadow-sm' : ''} ${color === '#ffffff' ? 'border-black/30 dark:border-black/50' : color === '#18181b' ? 'border-white/40 dark:border-white/30' : wireColor === color ? 'border-white' : 'border-transparent'}`}
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>

              <div className="h-4 w-px bg-[var(--border-main)] mx-2"></div>
              <button
                onClick={() => handleRotateComponent(-1)}
                disabled={!selectedComponentId}
                className="p-1.5 text-blue-400 hover:bg-blue-500/10 rounded transition disabled:opacity-30"
                title="Rotate Left"
              >
                <RotateCcw size={12} />
              </button>
              <button
                onClick={() => handleRotateComponent(1)}
                disabled={!selectedComponentId}
                className="p-1.5 text-blue-400 hover:bg-blue-500/10 rounded transition disabled:opacity-30"
                title="Rotate Right"
              >
                <RotateCw size={12} />
              </button>
              <button
                onClick={handleRemoveComponent}
                disabled={!selectedComponentId}
                className="p-1.5 text-red-400 hover:bg-red-500/10 rounded transition disabled:opacity-30"
                title="Remove Selected Component"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}

          {onSimulate && (
             <button
                onClick={onSimulate}
                disabled={isCompiling || isFlashing}
                className="ml-2 flex items-center gap-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-[10px] font-bold px-2 py-1 rounded transition shadow-sm"
              >
                <Zap size={10} /> {isSimulationActive ? "RESTART SIM" : "SIMULATE"}
              </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div 
          className="flex-1 overflow-hidden relative bg-[var(--bg-schematic)] select-none"
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={(e) => {
             if (appMode === "manual" && !drawingStart && e.target === e.currentTarget) {
               setSelectedComponentId(null);
             }
          }}
        >
          <TransformWrapper
            initialScale={1}
            minScale={0.05}
            maxScale={4}
            centerOnInit={false}
            limitToBounds={false}
            wheel={{ step: 0.001 }}
            pinch={{ step: 0.05 }}
            panning={{ disabled: draggedCompId !== null }}
            onTransform={(_ref, state) => { zoomScaleRef.current = state.scale; }}
          >
            {({ zoomIn, zoomOut, resetTransform }) => (
              <>
                <div className="absolute top-4 right-4 flex flex-col gap-2 z-10">
                  <button
                    onClick={() => zoomIn()}
                    className="p-1.5 bg-[var(--bg-panel)] border border-[var(--border-main)] shadow-sm hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-main)] rounded transition"
                    title="Zoom In"
                  >
                    <ZoomIn size={14} />
                  </button>
                  <button
                    onClick={() => zoomOut()}
                    className="p-1.5 bg-[var(--bg-panel)] border border-[var(--border-main)] shadow-sm hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-main)] rounded transition"
                    title="Zoom Out"
                  >
                    <ZoomOut size={14} />
                  </button>
                  <button
                    onClick={() => resetTransform()}
                    className="p-1.5 bg-[var(--bg-panel)] border border-[var(--border-main)] shadow-sm hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-main)] rounded transition"
                    title="Reset Zoom"
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>

                <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }} contentStyle={{ width: "100%", height: "100%" }}>
                  <div className="w-full h-full relative" style={{ minWidth: 20000, minHeight: 20000, left: -10000, top: -10000 }}>
                    
                    <svg className="absolute inset-0 w-full h-full pointer-events-none">
                      <defs>
                        <pattern id="schematic-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" className="text-[var(--text-muted)] opacity-20" strokeWidth="1" />
                        </pattern>
                      </defs>
                      <rect width="100%" height="100%" fill="url(#schematic-grid)" />
                    </svg>

                    <div style={{ position: 'absolute', left: 10000, top: 10000, width: 0, height: 0 }}>
                      {/* The microcontroller board itself — a fixed anchor every wire can target via 'mcu' */}
                      <div className="absolute group" style={{ left: boardConfig.x, top: boardConfig.y, width: boardConfig.width, height: boardConfig.height }}>
                        <div className="pointer-events-none" style={{ transform: `scale(${boardConfig.scale})`, transformOrigin: 'top left' }}>
                          {React.createElement(mcu === "esp32" ? "wokwi-esp32-devkit-v1" : "wokwi-arduino-uno", {})}
                        </div>
                        <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-slate-300 font-sans pointer-events-none opacity-0 group-hover:opacity-100 transition">
                          {mcu === "esp32" ? "ESP32 DevKit v1" : "Arduino Uno"}
                        </div>
                        {appMode === "manual" && mcuPinList.map(pinName => {
                          const offset = getMcuPinOffset(pinName);
                          const isDrawingHere = drawingStart?.compId === "mcu" && drawingStart?.pinName === pinName;
                          return (
                            <div
                              key={pinName}
                              onMouseDown={(e) => { e.stopPropagation(); handlePinMouseDown("mcu", pinName); }}
                              onMouseUp={(e) => { e.stopPropagation(); handlePinMouseUp("mcu", pinName); }}
                              // Board pins can be as little as ~10px apart, so keep this
                              // marker small — a 12px dot at that spacing looked like one
                              // solid merged bar instead of distinct clickable pins.
                              className={`absolute w-[7px] h-[7px] -ml-[3.5px] -mt-[3.5px] cursor-pointer z-30 transition ${isDrawingHere ? 'bg-orange-500 scale-150 opacity-100' : 'bg-orange-400/40 hover:bg-orange-400/90 hover:scale-125 border border-orange-500/70'}`}
                              style={{ left: offset.x, top: offset.y }}
                              title={`MCU Pin: ${pinName}`}
                            />
                          );
                        })}
                      </div>

                      {components.map((comp) => {
                        const isSelected = selectedComponentId === comp.id;
                        const rotation = comp.rotation || 0;
                        const rad = (rotation * Math.PI) / 180;
                        const pins = Array.isArray(comp.pins) ? comp.pins : [];
                        // Footprint = bounding box of the pin layout, so the drag/hover
                        // hitbox always covers at least the clickable terminals (CSS
                        // transform:scale on the rendered SVG doesn't grow the layout box).
                        const footprintW = Math.max(60, ...pins.map(p => (p.x || 0) + 20));
                        const footprintH = Math.max(60, ...pins.map(p => (p.y || 0) + 20));

                        return (
                          <div
                            key={comp.id}
                            className={`absolute transition-shadow cursor-grab active:cursor-grabbing group ${isSelected ? 'ring-2 ring-blue-500 rounded' : ''}`}
                            style={{ left: comp.x || 0, top: comp.y || 0, width: footprintW, height: footprintH }}
                            onMouseDown={(e) => {
                              // While tracing a wire, don't drag the component underneath
                              // the cursor — let the press bubble to the canvas so it can
                              // drop a waypoint there instead.
                              if (appMode === "manual" && !drawingStart) {
                                e.stopPropagation();
                                setSelectedComponentId(comp.id);
                                setDraggedCompId(comp.id);
                                setDragOffset({ x: e.clientX, y: e.clientY });
                              }
                            }}
                          >
                            <div className="pointer-events-none">
                              {renderComponentBody(comp, isSimulationActive, footprintW, footprintH)}
                            </div>

                            <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-slate-300 font-sans pointer-events-none opacity-0 group-hover:opacity-100 transition">
                              {comp.label}
                            </div>

                            {appMode === "manual" && pins.map(pin => {
                              const isDrawingHere = drawingStart?.compId === comp.id && drawingStart?.pinName === pin.name;

                              const pinOffsetX = pin.x || 20;
                              const pinOffsetY = pin.y || 20;

                              const rotX = pinOffsetX * Math.cos(rad) - pinOffsetY * Math.sin(rad);
                              const rotY = pinOffsetX * Math.sin(rad) + pinOffsetY * Math.cos(rad);

                              return (
                                <div
                                  key={pin.name}
                                  onMouseDown={(e) => { e.stopPropagation(); handlePinMouseDown(comp.id, pin.name); }}
                                  onMouseUp={(e) => { e.stopPropagation(); handlePinMouseUp(comp.id, pin.name); }}
                                  className={`absolute w-[7px] h-[7px] -ml-[3.5px] -mt-[3.5px] cursor-pointer z-30 transition ${isDrawingHere ? 'bg-orange-500 scale-150 opacity-100' : 'bg-orange-400/40 hover:bg-orange-400/90 hover:scale-125 border border-orange-500/70'}`}
                                  style={{ left: rotX, top: rotY }}
                                  title={`${comp.label} Pin: ${pin.name}`}
                                />
                              );
                            })}
                          </div>
                        );
                      })}

                      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
                        {connections.map((conn) => {
                          const startPos = getPinPos(conn.fromComponentId, conn.fromPin);
                          const endPos = getPinPos(conn.toComponentId, conn.toPin);
                          const path = buildWirePath(startPos, endPos, conn.waypoints);
                          return (
                            <g key={conn.id}>
                              {conn.color === '#ffffff' && (
                                <path
                                  d={path}
                                  fill="none"
                                  stroke="rgba(0,0,0,0.3)"
                                  strokeWidth="4.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              )}
                              {conn.color === '#18181b' && (
                                <path
                                  d={path}
                                  fill="none"
                                  stroke="rgba(255,255,255,0.4)"
                                  strokeWidth="4.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              )}
                              <path
                                d={path}
                                fill="none"
                                stroke={conn.color}
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className={isSimulationActive ? "wire-active animate-pulse shadow-glow" : ""}
                              />
                              <circle cx={startPos.x} cy={startPos.y} r="3" fill={conn.color} />
                              <circle cx={endPos.x} cy={endPos.y} r="3" fill={conn.color} />
                              {conn.waypoints?.map((wp, i) => (
                                <circle key={i} cx={wp.x} cy={wp.y} r="2.5" fill={conn.color} />
                              ))}
                            </g>
                          );
                        })}

                        {drawingStart && mousePos && (() => {
                          const startPos = getPinPos(drawingStart.compId, drawingStart.pinName);
                          const cursorPos = { x: mousePos.x - 10000, y: mousePos.y - 10000 };
                          const path = buildWirePath(startPos, cursorPos, waypoints);
                          return (
                            <>
                              {wireColor === '#ffffff' && (
                                <path d={path} fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="4.5" strokeDasharray="5,5" strokeLinecap="round" strokeLinejoin="round" />
                              )}
                              {wireColor === '#18181b' && (
                                <path d={path} fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="4.5" strokeDasharray="5,5" strokeLinecap="round" strokeLinejoin="round" />
                              )}
                              <path d={path} fill="none" stroke={wireColor} strokeWidth="2.5" strokeDasharray="5,5" strokeLinecap="round" strokeLinejoin="round" />
                              {waypoints.map((wp, i) => (
                                <circle key={i} cx={wp.x} cy={wp.y} r="3" fill={wireColor} stroke="#fff" strokeWidth="1" />
                              ))}
                            </>
                          );
                        })()}
                      </svg>
                    </div>
                  </div>
                </TransformComponent>
              </>
            )}
          </TransformWrapper>

          {components.length === 0 && appMode === "agentic" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-[var(--bg-root)]/80 backdrop-blur-sm pointer-events-none">
              <div className="p-3 bg-blue-500/10 rounded-2xl text-blue-400 mb-3 animate-pulse">
                <Layers size={24} />
              </div>
              <h3 className="font-display font-medium text-[var(--text-main)] text-sm">No Circuit Elements Configured</h3>
              <p className="text-xs text-[var(--text-muted)] max-w-xs mt-1.5 leading-relaxed">
                Describe your project to the AI Code Agent on the right (e.g. "thermometer DHT11" or "sweeping servo") to automatically generate the wiring schematic blueprint.
              </p>
            </div>
          )}
        </div>

        {appMode === "manual" && (
          <div className="w-80 bg-[var(--bg-panel)] border-l border-[var(--border-main)] flex flex-col shadow-xl z-20">
            <div className="p-3 border-b border-[var(--border-main)] bg-[var(--bg-root)]">
              <h3 className="text-xs font-bold text-[var(--text-main)] uppercase tracking-wider">Components</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-3 terminal-scrollbar">
              <div className="grid grid-cols-3 gap-2">
                {AVAILABLE_COMPONENTS.map(c => (
                  <div 
                    key={c.type}
                    onClick={() => handleAddComponent(c.type, c.label)}
                    className="p-1.5 border border-[var(--border-main)] rounded bg-[var(--bg-root)] hover:border-blue-500 cursor-pointer transition flex flex-col items-center gap-1.5 group aspect-square justify-center"
                  >
                    <div className="h-10 w-full flex items-center justify-center pointer-events-none opacity-80 group-hover:opacity-100 transition overflow-hidden">
                      <div style={{ transform: 'scale(0.5)' }}>
                        {renderComponentBody({ type: c.type as any, rotation: 0 } as SchematicComponent, false)}
                      </div>
                    </div>
                    <span className="text-[9px] font-medium text-[var(--text-main)] text-center leading-tight truncate w-full">{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-[var(--bg-panel)] border-t border-[var(--border-main)] px-4 py-2 flex flex-wrap items-center justify-between gap-3 shrink-0 text-[10px] z-20">
        <div className="flex items-center gap-3">
          <span className="text-[var(--text-muted)] font-medium">Pin Type Colors:</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#f43f5e]"></span> VCC (Power)</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#71717a]"></span> GND (Ground)</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6]"></span> GPIO (Signals)</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b]"></span> PWM / Analog</span>
        </div>
        {appMode === "manual" && (
          <div className="text-[var(--text-muted)]">
            <span className="font-bold text-orange-400">Tip:</span> Drag from a pin to another pin to wire them directly, or click empty space while tracing to drop a joint and keep routing. Press Esc to cancel a wire in progress.
          </div>
        )}
      </div>
    </div>
  );
}

export default function SchematicViewer(props: SchematicViewerProps) {
  if (SCHEMATIC_VIEW_COMING_SOON) {
    return <SchematicComingSoonPanel appMode={props.appMode} />;
  }
  return <SchematicViewerImpl {...props} />;
}
