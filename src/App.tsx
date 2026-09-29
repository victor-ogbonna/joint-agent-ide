import React, { useState, useEffect, useRef, useMemo } from "react";
import { Cpu, Terminal as TerminalIcon, Sun, Moon, Layers, Code, Zap, FileCode, FolderOpen, ChevronDown, ChevronRight, Wallet, Shield, Check, Info, Settings, Bot, PenTool, X, Palette, Usb, MoreVertical, Plus, Activity, Monitor, Copy, Cloud, LogOut, Lock, Upload, MessageSquarePlus, Github, Trash2, Loader2, Globe, RefreshCw, Rocket, Puzzle, Download, Clock, Compass} from "lucide-react";
import { useAuth } from "./contexts/AuthContext";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip } from "recharts";
import {
  MCUType,
  SchematicComponent,
  SchematicConnection,
  ComponentPin,
  TerminalLine,
  Web3WalletState,
  ChatMessage,
  BoardInfo
} from "./types";
import CodeEditor, { AskAiRequest } from "./components/CodeEditor";
import SchematicViewer from "./components/SchematicViewer";
import Terminal from "./components/Terminal";
import AgentChat from "./components/AgentChat";
import Web3Panel from "./components/Web3Panel";
import ProjectsBrowser from "./components/ProjectsBrowser";
import NewProjectModal from "./components/NewProjectModal";
import WelcomeModal from "./components/WelcomeModal";
import FeedbackWidget from "./components/FeedbackWidget";
import GithubPanel from "./components/GithubPanel";
import WebPreviewPanel from "./components/WebPreviewPanel";
import PlansModal from "./components/PlansModal";
import LibrariesModal from "./components/LibrariesModal";
import OnboardingTour, { TourStep } from "./components/OnboardingTour";
import { canInstallApp, installApp, isInstalledFullscreenApp, onInstallAvailabilityChange } from "./lib/installApp";
import { WINDOW_HOURS, FREE_WINDOW_TOKENS, PRO_WINDOW_TOKENS, FREE_PROJECT_LIMIT, formatWait, formatWhen, formatDay, percentUsed } from "./lib/plans";
import { ESPLoader, Transport } from "esptool-js";
import { flashAvr } from "./lib/avrFlash";
import { isWebUsbAvailable, requestUsbSerialPort, getGrantedUsbSerialPorts, describeVisibleUsbDevices } from "./lib/webusbSerial";
import { createProject, getProject, updateProject, renameProject, listProjects, deleteProject, ProjectSummary, trimMessagesForStorage } from "./lib/projects";
import { sketchBaudRate, sketchOpensSerial, sketchSerial } from "./lib/sketchBaud";
import { usbChipName } from "./lib/usbChips";
import { callAiEndpoint, streamChatEndpoint, authedApiRequest, clearLastKnownBlock, primeLastKnownBlock, QuotaBlockedInfo } from "./lib/aiClient";

/**
 * Choose which granted serial port is the board.
 *
 * Every caller used to take `getPorts()[0]`, which is simply the port granted
 * FIRST — not the one the user just chose. On a machine that exposes an
 * internal Intel serial device (0x8086, which this file already has to
 * special-case in two other places) that is not the Arduino at all: the
 * flasher opened the wrong device, pulsed DTR at nothing, and timed out
 * waiting for a bootloader that was never on the other end. It looked
 * identical to a dead board.
 *
 * Preference order: the port the user actually connected, then a port whose
 * USB id we recognise as a microcontroller, then any non-Intel port, then ask.
 */
// Which rate the sketch opens Serial at: src/lib/sketchBaud.ts.


/**
 * A serial line as the monitor panel shows it: exactly what the board sent.
 * Board output is no longer tagged "[SERIAL] " anywhere — its own colour sets
 * it apart from the app's messages in the terminal — but a line logged by an
 * older build may still carry the tag, so it is stripped here too.
 */
const monitorText = (text: string): string => text.replace(/^\[SERIAL\] /, "");

// A preference an earlier build stored, which made Android offer Web Serial
// first and ask for a second tap. That flow is gone; clear what it left.
try { localStorage.removeItem("android.preferWebSerial"); } catch { /* storage off */ }

/**
 * What to tell someone whose genuine Arduino a phone will not release.
 *
 * On Android, a board whose USB chip is standard USB serial — a genuine Mega
 * or Uno's ATmega16U2 — is taken by the phone's own cdc_acm driver, and Chrome
 * is not allowed to detach it (chrome://device-log: "Not allowed to detach
 * interface 1 attached to driver cdc_acm"). No browser API can reach it. A
 * CH340 or FTDI USB-serial adapter on the board's serial pins can: Android has
 * no driver for those, and the app already flashes through them.
 */
const phoneHeldBoardGuidance = (vendorId?: number, productId?: number): string[] => {
  const info = getBoardInfo(vendorId, productId);
  const board = info?.name || "board";
  const short = /Mega/.test(board) ? "Mega" : /Uno/.test(board) ? "Uno" : "board";
  return [
    `[USB] This phone's own USB-serial driver has taken your ${board}, and Android does not let a browser take it back. ` +
      `It connects normally from a computer. On this phone, connect it through a CH340 or FTDI USB-to-serial adapter instead (set to 5V):`,
    `  • Adapter GND → ${short} GND`,
    `  • Adapter TX  → ${short} RX0 (pin 0)`,
    `  • Adapter RX  → ${short} TX0 (pin 1)`,
    `  • Adapter DTR → 0.1 µF capacitor → ${short} RESET`,
    `  • Adapter 5V  → ${short} 5V (or power the ${short} separately)`,
    `[USB] Leave the ${short}'s own USB port unplugged, plug the adapter into the phone and tap Detect Board. ` +
      `It shows up as a CH340 or FTDI device, and flashing and the serial monitor then work as normal.` +
      // The adapter reports itself, not the board, so the project decides
      // what is built — the one thing that differs between a Mega and an Uno.
      (short === "board" ? "" : ` Flash it from a ${short} project: behind an adapter a Mega and an Uno look the same, so the project's board decides what is built.`),
  ];
};

const pickBoardPort = async (
  preferred: any,
  granted: () => Promise<any[]>,
  request: () => Promise<any>
): Promise<any> => {
  if (preferred) return preferred;
  const ports: any[] = await granted();
  const infoOf = (p: any) => { try { return p.getInfo() || {}; } catch { return {}; } };
  const candidates = ports.filter((p) => infoOf(p).usbVendorId !== 0x8086);
  const known = candidates.find((p) => {
    const i = infoOf(p);
    return Boolean(getBoardInfo(i.usbVendorId, i.usbProductId));
  });
  return known || candidates[0] || (await request());
};

const describePort = (port: any): string => {
  try {
    const i = port.getInfo() || {};
    if (!i.usbVendorId) return "unidentified serial device";
    const b = getBoardInfo(i.usbVendorId, i.usbProductId);
    const ids = `VID 0x${i.usbVendorId.toString(16).toUpperCase()}, PID 0x${(i.usbProductId ?? 0).toString(16).toUpperCase()}`;
    return b ? `${b.name} (${ids})` : ids;
  } catch { return "unidentified serial device"; }
};

// type === null means "a serial bridge we cannot attribute to a chip family".
/**
 * Why this browser can or cannot talk to a board, in the user's terms.
 *
 * Flashing needs the Web Serial API, which today exists only in Chromium
 * browsers on desktop operating systems. The previous fallback asked the
 * SERVER for its serial ports — but the server is a datacentre container with
 * no USB, so a phone user was told "No serial devices found. Connect a
 * microcontroller and try again", which is advice that can never work. Say
 * what is actually true instead.
 */
function describeSerialSupport(): { supported: boolean; reason: string; advice: string } {
  if (typeof navigator !== "undefined" && ("serial" in navigator || "usb" in navigator)) {
    return { supported: true, reason: "", advice: "" };
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  // iPadOS reports itself as a Mac, so the touch-point check is what separates
  // an iPad from a MacBook running Safari.
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (typeof navigator !== "undefined" && (navigator as any).platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isFirefox = /Firefox\//.test(ua);

  if (isIOS) {
    return {
      supported: false,
      reason: "Apple requires every browser on iPhone and iPad to use its WebKit engine, and WebKit does not implement Web Serial or WebUSB.",
      advice: "Flashing from an iPhone or iPad is not possible from a web page today — not in Safari, and not in Chrome for iOS either, because it is WebKit underneath. Everything else here works: write, compile and save. To flash, open this project on a computer, or on an Android phone in Chrome.",
    };
  }
  if (isAndroid) {
    // Reachable only in an Android browser with neither API — Firefox, or a
    // webview. Chrome for Android has WebUSB and is handled above.
    return {
      supported: false,
      reason: "This Android browser exposes neither Web Serial nor WebUSB.",
      advice: "Open this page in Chrome for Android, which can flash over WebUSB with a USB-C OTG adapter.",
    };
  }
  if (isFirefox) {
    return {
      supported: false,
      reason: "Firefox does not implement Web Serial.",
      advice: "Open this page in Chrome or Edge on the same computer to flash — your projects are saved to your account, so nothing is lost.",
    };
  }
  return {
    supported: false,
    reason: "This browser does not implement Web Serial.",
    advice: "Safari has no Web Serial support on any platform. On a Mac, open this page in Chrome or Edge and flashing works normally.",
  };
}

// boardId, when present, is a PlatformIO board id from /api/boards. Only set it
// where the VID/PID pins down one exact board — a generic serial bridge or a
// bare "Arduino" VID does not, and guessing there would preselect the wrong
// build target. It is a default for the New Project dialog, never an override.
const getBoardInfo = (vendorId: number | undefined, productId: number | undefined): { name: string, type: MCUType | null, boardId?: string } | null => {
  const info = getBoardInfoBase(vendorId, productId);
  if (!info) return null;
  // Name the USB chip too, e.g. "Arduino Mega 2560 (ATmega16U2)", the way a
  // bridge was already named "(FTDI FT232R)".
  const chip = usbChipName(vendorId, productId);
  if (!chip || info.name.includes(chip)) return info;
  return { ...info, name: info.name.startsWith("USB serial device") ? `USB serial device (${chip})` : `${info.name} (${chip})` };
};

const getBoardInfoBase = (vendorId: number | undefined, productId: number | undefined): { name: string, type: MCUType | null, boardId?: string } | null => {
  if (!vendorId) return null;

  if (vendorId === 0x2341) {
    if (productId === 0x0010 || productId === 0x0042) return { name: "Arduino Mega 2560", type: "arduino", boardId: "megaatmega2560" };
    if (productId === 0x0043 || productId === 0x0001) return { name: "Arduino Uno", type: "arduino", boardId: "uno" };
    return { name: "Arduino", type: "arduino" };
  }

  if (vendorId === 0x1B4F) return { name: "Arduino (SparkFun)", type: "arduino" };
  if (vendorId === 0x239A) return { name: "Arduino (Adafruit)", type: "arduino" };
  if (vendorId === 0x2A03) return { name: "Arduino", type: "arduino" };

  // Espressif's own VID — native USB on S2/S3/C3. This one really is an ESP32.
  if (vendorId === 0x303A) return { name: "ESP32", type: "esp32" };

  // CH340 (0x1A86), CP2102 (0x10C4) and FTDI (0x0403) are generic USB-serial
  // bridges. They sit on ESP32 devkits AND on virtually every Arduino Uno/Nano
  // clone, so the VID says nothing about the chip behind it. This used to
  // return ESP32 for all three, which labelled every Arduino clone an ESP32 and
  // then overwrote the project's target — the build ran for 'uno', emitted
  // firmware.hex, and the server went looking for firmware.bin.
  // Report the bridge honestly and let the project's own board decide.
  if (vendorId === 0x1A86) return { name: "USB serial device (CH340)", type: null };
  if (vendorId === 0x10C4) return { name: "USB serial device (CP2102)", type: null };
  if (vendorId === 0x0403) return { name: "USB serial device (FTDI)", type: null };

  return null;
};

const INITIAL_CODE = `/**
 * Joint-Agent IoT Core Node
 * Agentic Embedded Development Loop
 */
#include <Arduino.h>

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

void setup() {
  // Initialize the digital pin as an output.
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Joint-Agent Node Booted. Active security core running.");
}

void loop() {
  Serial.println("MCU State: HIGH - Current active");
  digitalWrite(LED_BUILTIN, HIGH);   // Turn the LED on
  delay(1000);                   // Wait for a second
  
  Serial.println("MCU State: LOW - Off");
  digitalWrite(LED_BUILTIN, LOW);    // Turn the LED off
  delay(1000);                   // Wait for a second
}`;


// Kept in sync with src/components/SchematicViewer.tsx's getPinsForType —
// coordinates hand-calibrated via tools/pin-calibrator.html.
const getPinsForType = (type: string) => {
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

const augmentComponents = (components: SchematicComponent[]) => {
  return components.map((c, i) => ({
    ...c,
    x: c.x !== undefined ? c.x : 100 + (i % 3) * 150,
    y: c.y !== undefined ? c.y : 150 + Math.floor(i / 3) * 120,
    pins: (c.pins || getPinsForType(c.type)) as ComponentPin[]
  }));
};

const INITIAL_COMPONENTS: SchematicComponent[] = [];

const INITIAL_CONNECTIONS: SchematicConnection[] = [];

type AppMode = "agentic" | "manual";
type EditorTab = "code" | "schematic";

type AppTheme = "light" | "dark";

// The workspace is three side-by-side resizable panels, which is unusable
// below roughly a tablet's width — 1024px is where all three still have room.
// Under that we show one panel at a time via the bottom switcher instead.
const NARROW_QUERY = "(max-width: 1023px)";

function useIsNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(mq.matches);
    mq.addEventListener("change", sync);
    // The matchMedia change event alone proved unreliable (it didn't fire on
    // a viewport change during testing), which would strand a rotating phone
    // on the wrong layout until reload — resize is the dependable backstop.
    window.addEventListener("resize", sync);
    sync();
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);
  return narrow;
}

type MobilePane = "files" | "agent" | "editor";

export default function App() {
  const { user, signOut } = useAuth();
  const isNarrow = useIsNarrowScreen();

  /**
   * On a phone, run the workspace fullscreen. The navigation bar sat right
   * where a thumb rests, and a stray tap on Home or Back threw the user out
   * of their workspace mid-task. Fullscreen hides the system bars; a swipe
   * from the edge brings them back for a moment, which is Android's own
   * immersive behaviour. If the user leaves fullscreen, or a USB permission
   * prompt takes it away, the next tap on the workspace restores it.
   *
   * Entering fullscreen uses up the tap's user activation, and the WebUSB
   * and Web Serial choosers need that same activation. So taps on buttons,
   * links and fields are left alone: Detect Board must still open its
   * chooser. Only taps on the workspace itself enter fullscreen.
   *
   * iPhone Safari has no element fullscreen, so there this does nothing.
   *
   * Typing leaves fullscreen. Android does not resize a fullscreen page for
   * the keyboard, so the keyboard covered the chat box: it was there, under
   * the keys, and reappeared the moment fullscreen was exited by hand. Now a
   * text field taking focus exits fullscreen itself, the page resizes above
   * the keyboard as it always did outside fullscreen, and the next tap on
   * the workspace once typing is done goes back in.
   *
   * The installed app (opened from its home-screen icon) is already
   * fullscreen, with the keyboard resizing the page, so none of this runs
   * there. Asking for fullscreen on top would bring back Chrome's "drag from
   * the top" message and the covered chat box.
   */
  useEffect(() => {
    // A touch-only device, in either orientation — not just a narrow window,
    // since a phone turned sideways is wider than the narrow layout's cutoff.
    const touchOnly = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
    if (!touchOnly) return;
    if (isInstalledFullscreenApp()) return;
    const doc: any = document;
    const root: any = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request) return;
    const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], [contenteditable="true"]';
    const TEXT_ENTRY = 'textarea, [contenteditable="true"], input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="submit"]):not([type="range"]):not([type="color"])';
    const isFullscreen = () => Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
    const onTap = (e: MouseEvent) => {
      if (isFullscreen()) return;
      const target = e.target as Element | null;
      if (target?.closest?.(INTERACTIVE)) return;
      // Still typing: going back in now would put the keyboard over the field.
      if ((document.activeElement as Element | null)?.matches?.(TEXT_ENTRY)) return;
      try {
        Promise.resolve(request.call(root, { navigationUI: "hide" })).catch(() => { /* refused: stay as is */ });
      } catch { /* refused: stay as is */ }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!isFullscreen()) return;
      if (!(e.target as Element | null)?.matches?.(TEXT_ENTRY)) return;
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
      if (!exit) return;
      try {
        Promise.resolve(exit.call(doc)).catch(() => { /* already out */ });
      } catch { /* already out */ }
    };
    document.addEventListener("click", onTap);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("click", onTap);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);
  const [selectedPane, setSelectedPane] = useState<MobilePane>("editor");
  const [appMode, setAppMode] = useState<AppMode>("agentic");
  const [theme, setTheme] = useState<AppTheme>("dark");
  const [activeTab, setActiveTab] = useState<EditorTab>("code");
  // The agent pane doesn't exist in manual mode — without this, switching
  // modes while it's selected would leave every pane hidden (blank screen).
  const mobilePane: MobilePane =
    selectedPane === "agent" && appMode !== "agentic" ? "editor" : selectedPane;
  // Which way the last section change went, so the new one slides in from
  // that side. Set by swipes and by the bottom bar alike.
  const [paneDirection, setPaneDirection] = useState<"next" | "prev" | null>(null);
  const mobilePaneOrder: MobilePane[] = appMode === "agentic" ? ["files", "agent", "editor"] : ["files", "editor"];
  const mobilePaneRef = useRef<MobilePane>(mobilePane);
  mobilePaneRef.current = mobilePane;
  const setMobilePane = (pane: MobilePane) => {
    const from = mobilePaneOrder.indexOf(mobilePaneRef.current);
    const to = mobilePaneOrder.indexOf(pane);
    if (from !== to && from >= 0 && to >= 0) setPaneDirection(to > from ? "next" : "prev");
    setSelectedPane(pane);
  };
  const isNarrowRef = useRef(isNarrow);
  isNarrowRef.current = isNarrow;
  // Opening the code from the agent on a phone gives the editor most of the
  // screen: the terminal drops to a strip, until a dock is opened again.
  const [compactDock, setCompactDock] = useState(false);
  const [isPlansOpen, setIsPlansOpen] = useState(false);
  const [isLibrariesOpen, setIsLibrariesOpen] = useState(false);
  const [isPluginsOpen, setIsPluginsOpen] = useState(false);
  const [isBoardMenuOpen, setIsBoardMenuOpen] = useState(false);
  // The profile menu opens from the sidebar now, which a resizable panel
  // clips; it is placed on the page from where its row sits.
  const [profileMenuAt, setProfileMenuAt] = useState<{ left: number; top: number } | null>(null);
  // Whether Chrome will install the site as an app right now. Never true
  // inside the installed app itself.
  const [canInstall, setCanInstall] = useState(canInstallApp);
  useEffect(() => onInstallAvailabilityChange(() => setCanInstall(canInstallApp())), []);
  /**
   * The account's plan as the server reports it: "pro" (subscribed or
   * granted), "unmetered" or "free". Kept apart from `tier`, which the chat
   * stream overwrites with "full"/"free" and so cannot say whether someone is
   * on PRO. Null until the server has answered, so a PRO user is never shown
   * an upgrade in between.
   */
  const [accountTier, setAccountTier] = useState<string | null>(null);
  const isPro = accountTier === "pro" || accountTier === "unmetered";
  // Plan Mode is part of PRO. Until the plan is known it stays hidden, so a
  // free account never sees it appear and vanish.
  const planModeAvailable = isPro;

  /**
   * Swipe between the phone's sections: left for the next one, right for the
   * previous, in the bottom bar's order. Only a quick, clearly sideways flick
   * counts, so scrolling a chat or the terminal never switches sections by
   * accident. A code line or terminal line that can still scroll sideways gets
   * the swipe first, and the panel resize bar is left alone.
   */
  const swipeRef = useRef<{ x: number; y: number; t: number; scroller: HTMLElement | null; scrollLeft: number; skip: boolean } | null>(null);
  const horizontalScrollerOf = (el: HTMLElement | null, stop: HTMLElement): HTMLElement | null => {
    for (let node = el; node && node !== stop; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") return node;
      }
    }
    return null;
  };
  const handleMainTouchStart = (e: React.TouchEvent<HTMLElement>) => {
    if (!isNarrow || e.touches.length !== 1) { swipeRef.current = null; return; }
    const touch = e.touches[0];
    const target = e.target as HTMLElement;
    const scroller = horizontalScrollerOf(target, e.currentTarget);
    swipeRef.current = {
      x: touch.clientX, y: touch.clientY, t: Date.now(),
      scroller, scrollLeft: scroller?.scrollLeft ?? 0,
      skip: Boolean(target.closest?.('[role="separator"], [data-separator], [data-no-swipe]')),
    };
  };
  const handleMainTouchEnd = (e: React.TouchEvent<HTMLElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || start.skip || e.changedTouches.length !== 1) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8 || Date.now() - start.t > 700) return;
    const sc = start.scroller;
    if (sc) {
      // Finger moving left reveals more to the right, and the reverse.
      const canGoFurther = dx < 0 ? start.scrollLeft + sc.clientWidth < sc.scrollWidth - 1 : start.scrollLeft > 0;
      if (canGoFurther) return;
    }
    const at = mobilePaneOrder.indexOf(mobilePane);
    const next = mobilePaneOrder[at + (dx < 0 ? 1 : -1)];
    if (next) setMobilePane(next);
  };
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [isEdgeImpulseModalOpen, setIsEdgeImpulseModalOpen] = useState(false);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [quotaBlockInfo, setQuotaBlockInfo] = useState<QuotaBlockedInfo | null>(null);
  /** The last compile error in the code itself, for Ask AI's "Fix errors". */
  const lastCompileErrorRef = useRef<string | null>(null);
  // While paused, tick so the countdown moves, and lift the pause the moment
  // its refill time comes: the agent is usable again without a reload.
  const [pauseNow, setPauseNow] = useState(() => Date.now());
  useEffect(() => {
    const resetAt = quotaBlockInfo?.resetAt;
    if (!resetAt) return;
    const tick = () => {
      const now = Date.now();
      setPauseNow(now);
      if (now >= resetAt) {
        clearLastKnownBlock();
        setQuotaBlockInfo(null);
        setIsUpgradeModalOpen(false);
      }
    };
    tick();
    const id = window.setInterval(tick, 15000);
    // A phone that slept through the refill catches up as soon as it wakes.
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [quotaBlockInfo?.resetAt]);
  /** "2 h 13 min", or null when only the billing date lifts the pause. */
  const pauseWait = quotaBlockInfo?.resetAt ? formatWait(quotaBlockInfo.resetAt, pauseNow) : null;
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [mcuPluggedIn, setMcuPluggedIn] = useState(false);
  const mcuPluggedInRef = useRef(false);

  // When the board last came online, so a tap that lands as it connects is
  // not taken as a request to flash.
  const boardConnectedAtRef = useRef(0);
  useEffect(() => {
    mcuPluggedInRef.current = mcuPluggedIn;
    if (mcuPluggedIn) boardConnectedAtRef.current = Date.now();
  }, [mcuPluggedIn]);
  const detectedBoardRef = useRef<string | null>(null);
  const [isTerminalOpen, setIsTerminalOpen] = useState(true);
  const [isSerialMonitorOpen, setIsSerialMonitorOpen] = useState(false);
  const [isSerialPlotterOpen, setIsSerialPlotterOpen] = useState(false);
  const [autoScrollSerial, setAutoScrollSerial] = useState(true);
  /**
   * A phone cannot hold two dock panes side by side: at ~380px each pane gets
   * ~190px, and its header (icon + title + buttons) wraps over the output.
   * On narrow screens the dock becomes tabbed — one full-width pane at a time.
   * Desktop is untouched and keeps the split view.
   */
  const [mobileDockTab, setMobileDockTab] = useState<"terminal" | "serial" | "plotter">("terminal");
  const serialMonitorRef = useRef<HTMLDivElement>(null);
  const openDocks = ([
    ["terminal", isTerminalOpen],
    ["serial", isSerialMonitorOpen],
    ["plotter", isSerialPlotterOpen],
  ] as const).filter(([, open]) => open).map(([id]) => id);
  // If the tab a user last chose has since been closed, fall back to whatever
  // is still open rather than showing an empty dock.
  const activeDock = openDocks.includes(mobileDockTab) ? mobileDockTab : openDocks[0];
  const showsDock = (id: "terminal" | "serial" | "plotter") => !isNarrow || activeDock === id;

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // "free" on the Free plan: shorter replies, no auto-debug, no Plan Mode, a
  // compile allowance. A ref as well, because Smart Flash runs from closures
  // that predate the latest state.
  const [tier, setTier] = useState<string | null>(null);
  const tierRef = useRef<string | null>(null);
  useEffect(() => { tierRef.current = tier; }, [tier]);
  const [usageInfo, setUsageInfo] = useState<{
    tokensUsed: number;
    /** Null: never metered. */
    tokenCap: number | null;
    windowResetAt: number | null;
    cycleUsed: number | null;
    cycleCap: number | null;
    subscriptionStatus: string;
    /** When a renewing plan renews. */
    renewsAt: number | null;
    /** When a cancelled or unpaid plan's PRO ends. */
    proUntil: number | null;
  } | null>(null);
  const [isCancelingSubscription, setIsCancelingSubscription] = useState(false);

  const [mcu, setMcu] = useState<MCUType>("esp32");
  const [boardId, setBoardId] = useState<string>("esp32dev");
  const [chatMode, setChatMode] = useState<"plan" | "implement">("plan"); // internal representation, hidden from user
  const [detectedBoard, setDetectedBoard] = useState<string | null>(null);
  useEffect(() => {
    detectedBoardRef.current = detectedBoard;
  }, [detectedBoard]);
  // The catalogue board id behind detectedBoard, when USB identified one exactly.
  const [detectedBoardId, setDetectedBoardId] = useState<string | null>(null);
  // What the USB id reports, as opposed to what the project targets. null when
  // the adapter can't identify the chip (CH340 clones and the like), which is
  // not a mismatch — it is simply unknown, so it must not block a flash.
  const [detectedMcu, setDetectedMcu] = useState<MCUType | null>(null);

  const bootLoggedRef = useRef(false);
  const autoConnectedLogRef = useRef(false);

  const [code, setCode] = useState(INITIAL_CODE);
  // The rate the monitor opens at: whatever the current sketch passes to
  // Serial.begin(). A ref, because the monitor also starts from closures that
  // predate the latest code (the agent's reply handler, the USB listeners).
  const monitorBaudRef = useRef(sketchBaudRate(INITIAL_CODE));
  // Whether the sketch opens Serial at all; without it the monitor has
  // nothing to show, whatever rate it listens at.
  const sketchOpensSerialRef = useRef(sketchOpensSerial(INITIAL_CODE));
  // Whether that rate could be read from the sketch, or 115200 is a guess.
  const sketchBaudKnownRef = useRef(sketchSerial(INITIAL_CODE)?.baud != null);
  // The editor's code, for requests made from closures older than it.
  const codeRef = useRef(INITIAL_CODE);
  useEffect(() => {
    monitorBaudRef.current = sketchBaudRate(code);
    sketchOpensSerialRef.current = sketchOpensSerial(code);
    sketchBaudKnownRef.current = sketchSerial(code)?.baud != null;
    codeRef.current = code;
  }, [code]);
  const [editorFontSize, setEditorFontSize] = useState<number>(14);
  const [editorWordWrap, setEditorWordWrap] = useState<boolean>(true);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  const [description, setDescription] = useState(
    "A standard flashing LED circuit safely wired through a 220 Ohm current-limiting resistor. Ideal for validating MCU state loops."
  );
  const [components, setComponents] = useState<SchematicComponent[]>(INITIAL_COMPONENTS);
  const [connections, setConnections] = useState<SchematicConnection[]>(INITIAL_CONNECTIONS);

  // Saved projects (Firestore) — currentProjectId is null while working in an
  // unsaved "scratch" session (the IDE still works fully without one).
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  // Mirrors currentProjectId for async callbacks (AI responses, debug results)
  // to check against once their request resolves — if the user has switched
  // to a different project in the meantime, the stale result must not be
  // applied to the now-open project's code/schematic.
  const currentProjectIdRef = useRef<string | null>(null);
  useEffect(() => { currentProjectIdRef.current = currentProjectId; }, [currentProjectId]);
  const [currentProjectName, setCurrentProjectName] = useState<string>("");
  const [isProjectNameEditing, setIsProjectNameEditing] = useState(false);
  const [showProjectsBrowser, setShowProjectsBrowser] = useState(false);
  // Recent projects shown inline in the sidebar. Kept separate from the Browse
  // modal's own fetch so the list is visible without opening anything, but it
  // reuses handleOpenProject so there is only one code path for loading.
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([]);
  // boardId -> display name, for labelling saved projects. Fetched once and
  // shared, so projects created before boards were labelled still resolve.
  const [boardNames, setBoardNames] = useState<Map<string, string>>(new Map());
  // Shown once per sign-in: "start new" vs "continue previous". Keyed on uid in
  // a ref so a re-render never reopens it, but signing in as someone else does.
  const [showWelcome, setShowWelcome] = useState(false);
  // The walk-through: automatic on a first-time account's first visit, and
  // on request from the profile menu. Seen once per account on this device.
  const [tourOpen, setTourOpen] = useState(false);
  const tourKey = (uid: string) => `tourSeen:${uid}`;
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [webPreviewOpen, setWebPreviewOpen] = useState(false);
  /** The monitor was running when the board went away, so bring it back when
   *  the board returns. Unplugging previously ended the session silently and
   *  left no way to resume short of reloading. */
  const wantSerialMonitorRef = useRef(false);
  const [recentFetched, setRecentFetched] = useState(false);
  const welcomeShownForRef = useRef<string | null>(null);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [importedFileCode, setImportedFileCode] = useState<string | null>(null);
  const [importedFileName, setImportedFileName] = useState<string>("");
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextAutosaveRef = useRef(false);

  // Loading/Spin states
  const [isLoading, setIsLoading] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [isSmartFlashing, setIsSmartFlashing] = useState(false);
  const [leftTab, setLeftTab] = useState<'agent' | 'debugger' | 'web3'>('agent');
  const [debugState, setDebugState] = useState({ activeLine: null as number | null, variables: {}, profiling: {} });
  const [isDebugging, setIsDebugging] = useState(false);
  const [isSimulationActive, setIsSimulationActive] = useState(false);
  const [retrievedFirmware, setRetrievedFirmware] = useState<Uint8Array | null>(null);

  // Terminal & Chats
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  // The latest handleSendMessage, for sends started from older closures (the
  // agent's command handler); refreshed on every render below.
  const sendMessageRef = useRef<((text: string, modeOverride?: "plan" | "implement", images?: string[]) => Promise<void>) | null>(null);
  const autoSerialRequestAtRef = useRef(0);
  // How full the conversation's context budget is, as the model last counted
  // it. null until the first reply of a session on this project.
  const [contextUsage, setContextUsage] = useState<{ used: number; limit: number } | null>(null);

  useEffect(() => {
    if (autoScrollSerial && serialMonitorRef.current) {
      serialMonitorRef.current.scrollTop = serialMonitorRef.current.scrollHeight;
    }
  }, [terminalLines, autoScrollSerial]);

  // Seed the known token-quota state once on login, so a user who's already
  // capped out sees the upgrade modal on their first send attempt instead of
  // a normal-looking input box that then fails.
  useEffect(() => {
    clearLastKnownBlock();
    if (!user) return;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/quota/status", { headers: { Authorization: `Bearer ${idToken}` } });
        if (!res.ok) return;
        const status = await res.json();
        if (status.tier) { setTier(status.tier); setAccountTier(status.tier); }
        if (status.blocked) {
          const info: QuotaBlockedInfo = {
            tier: status.tier === "free" ? "free" : "paid",
            tokensUsed: status.tokensUsed,
            tokenCap: status.tokenCap ?? 0,
            reason: status.reason ?? null,
            resetAt: typeof status.resetAt === "number" ? status.resetAt : null,
          };
          setQuotaBlockInfo(info);
          primeLastKnownBlock(info);
        }
      } catch {
        // Non-fatal — the next AI call will surface a 402 if the user is actually blocked.
      }
    })();
  }, [user]);

  const handleOpenProfileMenu = () => {
    setIsMenuOpen((open) => !open);
    if (!user) return;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch("/api/quota/status", { headers: { Authorization: `Bearer ${idToken}` } });
        if (!res.ok) return;
        const status = await res.json();
        setUsageInfo({
          tokensUsed: status.tokensUsed ?? 0,
          tokenCap: typeof status.tokenCap === "number" ? status.tokenCap : null,
          windowResetAt: typeof status.windowResetAt === "number" ? status.windowResetAt : null,
          cycleUsed: typeof status.cycleUsed === "number" ? status.cycleUsed : null,
          cycleCap: typeof status.cycleCap === "number" ? status.cycleCap : null,
          subscriptionStatus: status.subscriptionStatus,
          renewsAt: typeof status.renewsAt === "number" ? status.renewsAt : null,
          proUntil: typeof status.proUntil === "number" ? status.proUntil : null,
        });
        if (status.tier) setAccountTier(status.tier);
      } catch {
        // Non-fatal — the dropdown just won't show a usage figure this time.
      }
    })();
  };

  const handleCancelSubscription = async () => {
    if (!user) return;
    if (!window.confirm("Cancel your $7/month subscription? You'll keep PRO until the current cycle ends, then your account returns to the Free plan.")) return;
    setIsCancelingSubscription(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/paystack/cancel", { method: "POST", headers: { Authorization: `Bearer ${idToken}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not cancel subscription.");
      const proUntil = typeof data.proUntil === "number" ? data.proUntil : null;
      setUsageInfo((prev) => (prev ? { ...prev, subscriptionStatus: "canceled", renewsAt: null, proUntil } : prev));
      logToTerminal(`[BILLING] Subscription canceled. You won't be charged again${proUntil ? `, and you keep PRO until ${formatDay(proUntil)}` : ""}.`, "info");
    } catch (err: any) {
      logToTerminal(`[BILLING] Cancel failed: ${err.message}`, "error");
    } finally {
      setIsCancelingSubscription(false);
    }
  };

  const plotterData = useMemo(() => {
    const serialLines = terminalLines.filter(l => l.type === "serial");
    const data = [];
    let index = 0;
    for (const line of serialLines.slice(-100)) {
      const text = line.text.trim();
      const num = parseFloat(text);
      if (!isNaN(num)) {
        data.push({ index: index++, value: num });
      } else {
        const match = text.match(/-?\d+(\.\d+)?/);
        if (match) {
          data.push({ index: index++, value: parseFloat(match[0]) });
        }
      }
    }
    return data;
  }, [terminalLines]);

  // Web3 MetaMask Wallet
  const [walletState, setWalletState] = useState<Web3WalletState>({
    connected: false,
    address: null,
    chainId: null,
    balance: null,
    authenticating: false,
    authenticated: false
  });

  // Decentralized Blockchain Ledger Logs
  const [blockchainLogs, setBlockchainLogs] = useState<Array<{ hash: string; txHash: string; timestamp: string; mcu: string }>>([]);

  const activePortRef = useRef<any>(null);
  const serialReaderRef = useRef<any>(null);
  // The in-flight monitor read loop, so stopping one can wait for it to exit
  // rather than assume it has.
  const monitorLoopRef = useRef<Promise<void> | null>(null);
  // Monitor starts and stops run one at a time, in the order they were asked.
  const monitorQueueRef = useRef<Promise<void>>(Promise.resolve());
  const abortControllerRef = useRef<AbortController | null>(null);

  // Log message helper to Terminal
  const logToTerminal = (text: string, type: TerminalLine["type"] = "info") => {
    const timestamp = new Date().toLocaleTimeString();
    setTerminalLines((prev) => [
      ...prev,
      {
        id: Math.random().toString(),
        timestamp,
        text,
        type
      }
    ]);
  };

  useEffect(() => {
    // Initial hello terminal greetings
    if (!bootLoggedRef.current) {
      logToTerminal("==========================================================", "info");
      logToTerminal("  JOINT-AGENT IDE INITIALIZED                   ", "success");
      // So a pasted log always says which build produced it.
      logToTerminal(`  Build ${typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : "dev"}`, "info");
      logToTerminal("  Joint-Agent Embedded Core Ready                          ", "info");
      logToTerminal("==========================================================", "info");
      logToTerminal(`System Core: Node compiler initialized. Powered by Joint-Agent Engine.`, "info");
      bootLoggedRef.current = true;
    }

    const handleConnect = (e: any) => {
      // A port Chrome itself reports as not connected is only a remembered
      // permission — an FT232R, which carries a serial number, is remembered
      // after it is unplugged, and was then shown as connected.
      if (e.target?.connected === false) return;
      if (e.target && e.target.getInfo) {
        const info = e.target.getInfo();
        const vendorId = info.usbVendorId;
        if (vendorId !== 0x8086) {
          webSerialPortRef.current = e.target;
          const board = getBoardInfo(vendorId, info.usbProductId);
          const boardName = board ? board.name : "Generic serial device";

          if (!autoConnectedLogRef.current) {
            logToTerminal(`[USB] ${boardName} was connected automatically.`, "info");
            autoConnectedLogRef.current = true;
          }

          // Same rule as the manual connect path: never override the project's
          // board from a USB id. Auto-connect is even less deliberate than
          // clicking Connect, so it has less claim to change the build target.
          setMcuPluggedIn(true);
          setDetectedMcu(board?.type ?? null);
          // Resume a monitor the user had open before the cable came out.
          if (wantSerialMonitorRef.current && e.target) {
            logToTerminal("[SERIAL] Board back — resuming the monitor.", "info");
            setTimeout(() => { void startWebSerialMonitor(e.target); }, 600);
          }
          setDetectedBoard(`Connected: ${boardName}${vendorId ? ` (VID: 0x${vendorId.toString(16).toUpperCase()})` : ""}`);
          setDetectedBoardId(board?.boardId ?? null);
        }
      }
    };

    const handleDisconnect = (_e: any) => {
      if (mcuPluggedInRef.current) {
        logToTerminal("[USB] Device disconnected.", "error");
        autoConnectedLogRef.current = false;
        setMcuPluggedIn(false);
        setDetectedBoard(null);
        setDetectedBoardId(null);
        setDetectedMcu(null);
        webSerialPortRef.current = null;
        // The cable coming out mid-flash is exactly when the spinner used to
        // stick: the USB write throws from somewhere deep and the control kept
        // reading "Flashing..." until the page was reloaded. Nothing can be
        // flashing once the board is gone, so say so here too — belt and
        // braces alongside the try/finally around the flash itself.
        setIsFlashing(false);
        setIsSmartFlashing(false);
        // Drop the dead reader, but remember the monitor was wanted so
        // reconnecting resumes it. Go through stopSerialMonitor so the loop is
        // awaited and the stream lock is genuinely released — a half-released
        // reader on an unplug is what the next flash trips over.
        void stopSerialMonitor();
        if (wantSerialMonitorRef.current) {
          logToTerminal("[SERIAL] Board disconnected — plug it back in. If the monitor does not resume by itself, click Reconnect in the Serial Monitor.", "info");
        }
      }
    };

    // Both transports, because a board reached over WebUSB (every Android
    // phone) fires its unplug on navigator.usb. Listening only on
    // navigator.serial left the green "connected" chip up forever after the
    // cable came out.
    const serial = (navigator as any).serial;
    const usb = (navigator as any).usb;
    if (serial) {
      serial.addEventListener("connect", handleConnect);
      serial.addEventListener("disconnect", handleDisconnect);
      // A board already plugged in when the page opens raises no connect
      // event, so adopt one this site was allowed before — the way a phone
      // is usually used: board in first, page second. Intel's internal UART
      // is never a board.
      (async () => {
        try {
          const ports: any[] = await serial.getPorts();
          const port = ports.find((p) => { try { return p.getInfo().usbVendorId !== 0x8086 && p.connected !== false; } catch { return false; } });
          if (port && !mcuPluggedInRef.current) handleConnect({ target: port });
        } catch { /* nothing granted, or getPorts unavailable */ }
      })();
    }
    if (usb) {
      // A USBDevice has no getInfo(), so it cannot go through handleConnect —
      // and an arriving device is not something to auto-adopt anyway. Only the
      // departure matters here.
      usb.addEventListener("disconnect", handleDisconnect);
    }

    return () => {
      if (serial) {
        serial.removeEventListener("connect", handleConnect);
        serial.removeEventListener("disconnect", handleDisconnect);
      }
      if (usb) usb.removeEventListener("disconnect", handleDisconnect);
    };
  }, []);

  // Store selected backend port path for Firefox/Safari
  const selectedPortPathRef = useRef<string | null>(null);
  // The actual Web Serial port object the user picked. Previously only the
  // backend's string path was kept, so every browser-side operation fell back
  // to getPorts()[0].
  const webSerialPortRef = useRef<any>(null);
  const serialWsRef = useRef<WebSocket | null>(null);
  const hasWebSerial = "serial" in navigator;
  // Chrome on Android has no Web Serial but does have WebUSB, which is enough:
  // src/lib/webusbSerial.ts drives the bridge chip directly and presents the
  // same surface, so the STK500 and ESP32 code runs unchanged on a phone.
  const hasWebUsb = isWebUsbAvailable();
  const canReachBoard = hasWebSerial || hasWebUsb;

  /**
   * Ask the user to authorise a board.
   *
   * Web Serial first where it exists, but NOT exclusively: some Android builds
   * expose navigator.serial while listing no ports at all, and on Android the
   * real transport is WebUSB. Falling through means "the chooser was empty"
   * no longer dead-ends on whichever API happened to be present.
   */
  /**
   * A Web Serial port this site was already allowed, for the same physical
   * device. Costs one gesture-free getPorts() call and returns nothing when
   * Android's Web Serial cannot see the board — which is the case on at least
   * one phone this was tested against, so it is a recovery, not a promise.
   */
  const grantedWebSerialPortFor = async (vendorId?: number, productId?: number): Promise<any> => {
    if (!hasWebSerial || !vendorId) return null;
    try {
      const ports: any[] = await (navigator as any).serial.getPorts();
      return ports.find((p) => {
        try {
          const i = p.getInfo();
          return i.usbVendorId === vendorId && (productId === undefined || i.usbProductId === productId);
        } catch { return false; }
      }) ?? null;
    } catch { return null; }
  };

  const requestBoardPort = async (): Promise<any> => {
    // Android exposes navigator.serial but never lists a port on it, so
    // trying Web Serial first there guarantees an empty chooser the user has
    // to dismiss before the real one appears. Ask WebUSB first instead.
    const androidFirst = /Android/.test(navigator.userAgent) && hasWebUsb;

    if (androidFirst) {
      try {
        logToTerminal("[USB] Opening the WebUSB chooser…", "info");
        const p = await requestUsbSerialPort();
        logToTerminal("[USB] Transport: WebUSB.", "info");
        return p;
      } catch (err: any) {
        if (!hasWebSerial || err?.name !== "NotFoundError") throw err;
        logToTerminal("[USB] No WebUSB device chosen. Trying Web Serial...", "info");
        return await (navigator as any).serial.requestPort();
      }
    }

    if (hasWebSerial) {
      try {
        logToTerminal("[USB] Opening the Web Serial chooser…", "info");
        const p = await (navigator as any).serial.requestPort();
        logToTerminal("[USB] Transport: Web Serial.", "info");
        return p;
      } catch (err: any) {
        const empty = err?.name === "NotFoundError";
        if (!empty || !hasWebUsb) throw err;
        logToTerminal("[USB] Web Serial offered no ports. Trying WebUSB instead...", "info");
      }
    }
    const p = await requestUsbSerialPort();
    logToTerminal("[USB] Transport: WebUSB.", "info");
    warnIfKnownLimited(p);
    return p;
  };

  /**
   * Say up front when a board cannot be flashed on this transport, instead of
   * letting the user describe a project, wait for a cloud build and only then
   * hit a protocol failure.
   *
   * On Android there is no Web Serial, so the USB-serial bridge is driven by
   * this app rather than by the operating system's driver — and the FTDI path
   * still drops a byte from replies that nothing in the link reports as an
   * error. CH340 and native-USB boards are unaffected.
   */
  const warnIfKnownLimited = (p: any) => {
    try {
      const info = typeof p?.getInfo === "function" ? p.getInfo() : {};
      if (info?.usbVendorId !== 0x0403) return;      // FTDI only
      logToTerminal(
        "[USB] Heads up: this is an FTDI bridge, and flashing it over WebUSB is not reliable yet — " +
        "replies lose a byte for reasons not yet pinned down. Everything else works: write code, " +
        "compile, save, preview. To flash this board, open the project on a computer in Chrome or Edge.",
        "error"
      );
      logToTerminal(
        "[USB] ESP32 boards (CH340) and native-USB boards do flash from this phone.",
        "info"
      );
    } catch { /* advisory only, never block a connection */ }
  };

  /** Boards already authorised in a previous session. */
  const grantedBoardPorts = async (): Promise<any[]> =>
    hasWebSerial ? await (navigator as any).serial.getPorts() : await getGrantedUsbSerialPorts();

  const handleAutoDetect = async () => {
    logToTerminal("[USB] Scanning for connected microcontrollers...", "info");
    // One line that says exactly what this browser can do. Without it a failed
    // scan is unattributable: an empty chooser looks the same whether the API
    // is missing, the phone is not in host mode, or Android's own driver has
    // claimed the bridge chip.
    try {
      const serialPorts = hasWebSerial ? (await (navigator as any).serial.getPorts()).length : 0;
      const usbDevices = hasWebUsb ? (await (navigator as any).usb.getDevices()).length : 0;
      logToTerminal(
        `[USB] Browser support: Web Serial=${hasWebSerial ? "yes" : "no"}, WebUSB=${hasWebUsb ? "yes" : "no"} ` +
        `| already authorised: ${serialPorts} serial, ${usbDevices} USB` +
        `${window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? " | reduced-motion on" : ""}`,
        "info"
      );
    } catch { /* diagnostics must never block a scan */ }

    if (canReachBoard) {
      try {
        if (!hasWebSerial) {
          // Reported what the browser HAS, not which transport actually ran —
          // which made every mobile log ambiguous about the thing being
          // debugged. requestBoardPort now names the transport it used.
          logToTerminal(`[USB] Already authorised: ${await describeVisibleUsbDevices()}`, "info");
          logToTerminal("[USB] If the list is empty, the phone is not seeing the board — check the OTG adapter and that the cable carries data.", "info");
        }
        let port = await requestBoardPort();
        webSerialPortRef.current = port;
        // Anything still holding the port — a running monitor above all —
        // has to let go first, or open() fails with "The port is already open".
        await stopSerialMonitor();
        if (activePortRef.current) {
          try { await activePortRef.current.close(); } catch { /* already closed */ }
          activePortRef.current = null;
        }
        // Identity first. getInfo() reads the USB descriptor and needs no open
        // port, so a board we cannot claim is still a board we can name.
        const info = await port.getInfo();

        // Then find out whether this platform will actually hand us the
        // device. A genuine Arduino on Android is held by the phone's own
        // cdc_acm driver and can never be claimed — but that stops a FLASH,
        // not a detection: the board is plainly attached and identified.
        // Opening purely to read identity, and letting that failure abort the
        // whole scan, is why a Mega 2560 the chooser had just listed by name
        // ended up showing as not connected at all.
        let claimable = true;
        let claimError: any = null;
        try {
          try { await port.close(); } catch { /* not open, the normal case */ }
          await port.open({ baudRate: 115200 });
          await port.close();
        } catch (e: any) {
          claimable = false;
          claimError = e;
        }

        // A standard USB-serial board the phone holds cannot be claimed
        // through WebUSB, but Web Serial reaches the same board through
        // Android's own USB handling — the route the desktop uses. If this
        // site was already allowed that port, switch to it silently: same tap,
        // no second chooser, and nothing changes for a phone whose Web Serial
        // has nothing to offer. Only the chooser needs a user gesture, and by
        // here the tap that opened WebUSB's has been spent.
        if (!claimable && hasWebSerial) {
          const viaSerial = await grantedWebSerialPortFor(info.usbVendorId, info.usbProductId);
          if (viaSerial) {
            try {
              await viaSerial.open({ baudRate: 115200 });
              await viaSerial.close();
              logToTerminal("[USB] The phone holds this board, but it is already allowed on the phone's own serial driver — using that instead.", "success");
              port = viaSerial;
              webSerialPortRef.current = viaSerial;
              claimable = true;
              claimError = null;
            } catch { /* that route is no better; the guidance below stands */ }
          }
        }

        if (info.usbVendorId === 0x8086) {
          logToTerminal(`[USB] Error: Selected port is an internal Intel hub.`, "error");
          setDetectedBoard(null);
          setDetectedBoardId(null);
          setMcuPluggedIn(false);
          return;
        }

        const vendorId = info.usbVendorId;
        const board = getBoardInfo(info.usbVendorId, info.usbProductId);
        const boardName = board ? board.name : "Generic serial device";
        const boardTitle = `Connected: ${boardName}${vendorId ? ` (VID: 0x${vendorId.toString(16).toUpperCase()})` : ""}`;

        setDetectedBoard(boardTitle);
        setDetectedBoardId(board?.boardId ?? null);
        setDetectedMcu(board?.type ?? null);
        setMcuPluggedIn(true);
        logToTerminal(`[USB] Connected: ${boardName}.`, "success");

        if (!claimable) {
          // Say plainly what does and does not work, at the moment they
          // connect, rather than letting them find out at the end of a build.
          logToTerminal(
            "[USB] Detected, but this phone will not release the board to the browser — reading and flashing it from here will not work.",
            "error"
          );
          if (claimError?.code === "HELD_BY_PHONE_DRIVER") {
            phoneHeldBoardGuidance(claimError.usbVendorId, claimError.usbProductId)
              .forEach((line) => logToTerminal(line, "info"));
          } else if (claimError?.message) {
            logToTerminal(`[USB] ${claimError.message}`, "info");
          }
        }

        // The project's board is the user's explicit choice and drives the
        // build. Detection only ever narrows it, never silently replaces it —
        // a CH340 clone previously flipped an Arduino Uno project to ESP32 and
        // broke every compile afterwards.
        if (board?.type && board.type !== mcu) {
          logToTerminal(
            `[USB] That device reports as ${board.type.toUpperCase()}, but this project targets ${mcu.toUpperCase()}. Flashing is blocked until they match — change the board in the selector, or plug in a ${mcu.toUpperCase()} board.`,
            "error"
          );
        } else if (!board?.type) {
          logToTerminal(
            // Named exactly: a Mega and an Uno look the same behind an adapter,
            // and this line is where the user can see which one a build is for.
            `[USB] This adapter can't identify the chip behind it, so builds will target this project's board (${boardNames.get(boardId) || mcu.toUpperCase()}). ` +
              `If a different board is wired to it, switch the project's board first.`,
            "info"
          );
        }

        // Pick the monitor back up if it was running when the board went.
        // A CH340 or CP210x has no USB serial number, so the browser keeps no
        // permission for it once it is unplugged and never reports it coming
        // back — the automatic resume in handleConnect cannot fire for it.
        // Reconnecting such a board means clicking Detect Board, so resume here.
        if (wantSerialMonitorRef.current && claimable) {
          logToTerminal("[SERIAL] Board back — resuming the monitor.", "info");
          void startWebSerialMonitor(port);
        }
      } catch (err: any) {
        if (err.name === 'NotFoundError' || err.message?.includes("No port selected") || err.message?.includes("User rejected")) {
          logToTerminal("[USB] Port selection cancelled by user.", "info");
          return;
        }
        // No backend fallback here: /api/serial/ports asks the SERVER for its
        // USB devices, and the server is a datacentre container with none, so
        // it could only ever answer "No serial devices found. Connect a
        // microcontroller and try again" — advice that cannot work and that
        // buried the real error above it.
        if (err?.code === "HELD_BY_PHONE_DRIVER") {
          phoneHeldBoardGuidance(err.usbVendorId, err.usbProductId).forEach((line, i) => logToTerminal(line, i === 0 ? "error" : "info"));
          return;
        }
        logToTerminal(`[USB] ${err.message}`, "error");
      }
    } else {
      // Neither transport: explain honestly rather than probing the server,
      // which has no USB devices and only ever produced a misleading dead end.
      const { reason, advice } = describeSerialSupport();
      logToTerminal(`[USB] This browser cannot reach a board. ${reason}`, "error");
      logToTerminal(`[USB] ${advice}`, "info");
      // On a phone the terminal is inside another pane, so the explanation
      // would land somewhere the user never looks. Bring it to them.
      setIsTerminalOpen(true);
      if (isNarrow) setMobilePane("editor");
    }
  };

  const handleBackendDetect = async () => {
    try {
      const res = await authedApiRequest("/api/serial/ports");
      const data = await res.json();
      if (!data.ports || data.ports.length === 0) {
        logToTerminal("[USB] No serial devices found. Connect a microcontroller and try again.", "error");
        return;
      }

      if (data.ports.length === 1) {
        const p = data.ports[0];
        selectedPortPathRef.current = p.path;
        const boardType = p.board?.type === 'arduino' ? 'arduino' : 'esp32';
        setDetectedBoard(`Connected: ${p.board?.name || 'Device'} (${p.path})`);
        setDetectedMcu(p.board?.type === 'arduino' || p.board?.type === 'esp32' ? p.board.type : null);
        setMcu(boardType as MCUType);
        setMcuPluggedIn(true);
        logToTerminal(`[USB] Auto-selected ${p.board?.name || 'device'} on ${p.path}`, "success");
      } else {
        logToTerminal(`[USB] Found ${data.ports.length} serial ports:`, "info");
        let selected = data.ports[0];
        for (const p of data.ports) {
          const isMcu = p.vendorId && p.vendorId !== '8086';
          logToTerminal(`  ${p.path} - ${p.board?.name || 'Unknown'} (${p.manufacturer})${isMcu ? ' ★' : ''}`, "info");
          if (isMcu && selected === data.ports[0]) selected = p;
        }
        selectedPortPathRef.current = selected.path;
        const boardType = selected.board?.type === 'arduino' ? 'arduino' : 'esp32';
        setDetectedBoard(`Connected: ${selected.board?.name || 'Device'} (${selected.path})`);
        setDetectedMcu(selected.board?.type === 'arduino' || selected.board?.type === 'esp32' ? selected.board.type : null);
        setMcu(boardType as MCUType);
        setMcuPluggedIn(true);
        logToTerminal(`[USB] Selected ${selected.board?.name} on ${selected.path}`, "success");
      }

      connectSerialWs();
    } catch (err: any) {
      logToTerminal(`[USB] Backend detection failed: ${err.message}`, "error");
    }
  };

  const connectSerialWs = () => {
    if (serialWsRef.current) return;
    try {
      const wsUrl = `ws://${window.location.host}/ws/serial`;
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => logToTerminal("[WS] Serial monitor WebSocket connected.", "info");
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'serial_data' || msg.type === 'serial_raw') {
            logToTerminal(String(msg.data), "serial");
          } else if (msg.type === 'serial_error') {
            logToTerminal(`[SERIAL ERROR] ${msg.data}`, "error");
          } else if (msg.type === 'serial_disconnected') {
            logToTerminal("[SERIAL] Device disconnected.", "error");
          }
        } catch(e) {}
      };
      ws.onclose = () => { serialWsRef.current = null; };
      serialWsRef.current = ws;
    } catch(e) {}
  };

  // Execute terminal CLI commands
  /**
   * Open the serial monitor on the board that is already connected.
   *
   * Asked to "activate serial monitor", the agent had no way to do it: its
   * whole vocabulary was compile/flash/clear/help/engine/web3/ret. So it fell
   * back to the only tool that does anything — regenerating the sketch — and
   * the user watched a rebuild and a reflash instead of their serial output.
   */
  const openSerialMonitor = async (fromAgent = false) => {
    // Asked for the monitor, but the sketch never opens Serial: it would sit
    // empty. When the agent was asked, have it add serial output instead —
    // the flash that follows starts the monitor by itself. Once a minute at
    // most, so a sketch that still lacks it cannot loop.
    if (!sketchOpensSerialRef.current) {
      if (fromAgent && Date.now() - autoSerialRequestAtRef.current > 60_000) {
        autoSerialRequestAtRef.current = Date.now();
        logToTerminal("[SERIAL] Your sketch doesn't open the serial port yet — asking the agent to add serial output.", "info");
        setTimeout(() => {
          void sendMessageRef.current?.(
            "Add serial monitor output to the current sketch: call Serial.begin(115200) in setup() and print clear, " +
            "useful lines with Serial.println() — what the sketch is doing, readings and state changes. Keep every " +
            "existing pin, behaviour and timing exactly as it is.",
            "implement",
          );
          // After the reply that asked for the monitor has rendered, so the
          // send includes it.
        }, 300);
        return;
      }
      logToTerminal("[SERIAL] Your sketch never calls Serial.begin(), so the monitor will stay empty. Ask the agent to add serial output.", "info");
    }
    if (!mcuPluggedInRef.current) {
      logToTerminal("[SERIAL] No board is connected. Use Detect Board first, then ask again.", "error");
      return;
    }
    setIsSerialMonitorOpen(true);
    if (isNarrow) { setMobilePane("editor"); setMobileDockTab("serial"); }
    try {
      const port = await pickBoardPort(webSerialPortRef.current, grantedBoardPorts, requestBoardPort);
      await startWebSerialMonitor(port);
    } catch (err: any) {
      logToTerminal(`[SERIAL] Could not open the monitor: ${err.message}`, "error");
    }
  };

  /**
   * The monitor's Reconnect button. A CH340 or CP210x has no USB serial
   * number, so after a replug the browser has forgotten it and only a click
   * can hand it back. With the board still known, restart the monitor on it;
   * otherwise go through Detect Board, which resumes the monitor once the
   * board is picked.
   */
  const reconnectSerialMonitor = async () => {
    if (mcuPluggedInRef.current) {
      await openSerialMonitor();
      return;
    }
    wantSerialMonitorRef.current = true;
    await handleAutoDetect();
  };

  const handleExecuteCommand = (cmd: string, fromAgent = false) => {
    // A command the user typed should echo back; one the agent issued should
    // not. Echoing those put a shell line in the terminal naming the build
    // system, which is not something a user of this product should be reading.
    if (!fromAgent) logToTerminal(cmd, "input");
    const cmdClean = cmd.toLowerCase().trim();

    if (cmdClean === "help") {
      logToTerminal("Joint-Agent Terminal - Available commands:", "info");
      logToTerminal("  help                      List available shell commands", "success");
      logToTerminal("  compile                   Verify & compile the current C++ code", "success");
      logToTerminal("  flash                     Upload the binary code to target board", "success");
      logToTerminal("  clear                     Clear the terminal screen output", "success");
      logToTerminal("  monitor                   Open the serial monitor on the connected board", "success");
      logToTerminal("  engine                    View Joint-Agent Engine metadata", "success");
      logToTerminal("  web3 status               Print Web3 wallet linkage state", "success");
      logToTerminal("  ret                       Retrieve firmware from connected board", "success");
    } else if (cmdClean === "clear") {
      setTerminalLines([]);
    } else if (cmdClean === "compile") {
      handleCompile();
    } else if (cmdClean === "flash") {
      handleFlash();
    } else if (cmdClean === "ret") {
      handleRetrieveFirmware();
    } else if (cmdClean === "engine" || cmdClean === "pio system" || cmdClean === "platformio --version" || cmdClean === "pio --version") {
      // The old spellings stay as undocumented aliases so anyone who learned
      // them still gets an answer; only "engine" is advertised.
      logToTerminal("Joint-Agent Engine System Information:", "info");
      logToTerminal("  Engine:        Joint-Agent Engine (embedded build core)", "info");
      logToTerminal(`  Host OS:       Linux (Cloud Sandbox)`, "info");
      logToTerminal(`  Framework:     Arduino compiler suite`, "info");
    } else if (cmdClean === "monitor" || cmdClean === "serial monitor") {
      void openSerialMonitor(fromAgent);
    } else if (cmdClean === "web3 status") {
      if (walletState.connected) {
        logToTerminal(`Web3 Secure Link Address: ${walletState.address}`, "success");
      } else {
        logToTerminal("Web3 Wallet is currently detached. Use connection panel to activate.", "error");
      }
    } else {
      logToTerminal(`Unknown command: '${cmd}'. Type 'help' to view valid options.`, "error");
    }
  };

  // Compile microcontroller code simulation
  const handleCompile = async (overrideCode?: string): Promise<{ success: boolean, data?: any, errorText?: string, compileSucceeded?: boolean, limited?: { reason: "window" | "day"; resetAt: number | null }, missingLibrary?: string }> => {
    setIsCompiling(true);
    const codeToCompile = overrideCode || code;
    logToTerminal(`[COMPILER] Sending code to cloud build server for ${mcu.toUpperCase()}...`, "info");

    try {
      const response = await authedApiRequest("/api/compile", { body: { code: codeToCompile, mcu, boardId } });
      let data;
      try {
        data = await response.json();
      } catch (e) {
        throw new Error(`Server returned an invalid response (Compilation failed or timed out): ${response.statusText}`);
      }

      const freeLeft = response.headers.get("X-Free-Compiles-Left");
      if (freeLeft && freeLeft !== "unlimited") {
        logToTerminal(`[COMPILER] Free plan: ${freeLeft} compile${freeLeft === "1" ? "" : "s"} left for now. Failed builds don't count.`, "info");
      }
      if (data.success) {
        lastCompileErrorRef.current = null;
        logToTerminal(`[COMPILER] Build succeeded! Binary size: ${Math.round(data.binary.length * 0.75)} bytes.`, "success");
        setIsCompiling(false);
        return { success: true, data };
      } else {
        const errorText = data.error + (data.stderr ? "\n" + data.stderr : "");
        logToTerminal(`[COMPILER] Error: ${data.error}`, "error");
        // Show the tail of the real build output. Without this the only clue
        // the user (or we) got was a generic sentence, which is why a working
        // build looked like a code bug.
        if (data.detail) logToTerminal(data.detail, "error");
        else if (data.stderr) logToTerminal(data.stderr, "error");
        // The build stopped for want of a library: say where to add it.
        const missingLibrary = typeof data.hint === "string" && data.hint ? data.hint : undefined;
        if (missingLibrary) logToTerminal(`[COMPILER] ${missingLibrary}`, "warning");
        setIsCompiling(false);
        // Refused by the Free plan's compile limit: the code was never built.
        const limited = data.code === "FREE_COMPILE_LIMIT"
          ? { reason: data.reason === "day" ? "day" as const : "window" as const, resetAt: typeof data.resetAt === "number" ? data.resetAt : null }
          : undefined;
        // Only a real error in the code is worth handing to Ask AI.
        if (!limited && data.compileSucceeded !== true) lastCompileErrorRef.current = errorText;
        return { success: false, errorText, compileSucceeded: data.compileSucceeded === true, limited, missingLibrary };
      }
    } catch (err: any) {
      logToTerminal(`[COMPILER] Build failed: ${err.message}`, "error");
      setIsCompiling(false);
      return { success: false, errorText: err.message };
    }
  };

  const handleSignMessage = async (message: string): Promise<string | null> => {
    const ethereum = (window as any).ethereum;
    if (ethereum && walletState.address) {
      try {
        logToTerminal("[WEB3] Requesting cryptographic signature via secure tunnel...", "info");
        const signature = await ethereum.request({
          method: "personal_sign",
          params: [message, walletState.address]
        });
        logToTerminal(`[WEB3] Signature created successfully! Sig: ${signature.slice(0, 20)}...`, "success");
        return signature;
      } catch (err: any) {
        logToTerminal(`[WEB3] Signature request rejected: ${err.message || err}`, "error");
        return null;
      }
    } else {
      logToTerminal("[WEB3] Error: No Web3 Wallet connected. Please connect a valid wallet to sign payloads.", "error");
      return null;
    }
  };

  const handleRetrieveFirmware = async () => {
    if (!detectedBoard || !mcuPluggedIn) {
      logToTerminal("[RETRIEVE] ERROR: No board detected. Click 'Auto-Detect Board' first.", "error");
      return;
    }

    // Release any active serial monitor locks before we do anything
    // Wait for the monitor's read loop to actually exit. Cancelling without
    // waiting left the stream locked, so the close() below rejected and the
    // flasher's open() then failed with "The port is already open".
    await stopSerialMonitor();
    if (activePortRef.current) {
      try {
        await activePortRef.current.close();
      } catch (e) { }
      activePortRef.current = null;
    }

    logToTerminal(`[RETRIEVE] Initiating connection to ${detectedBoard}...`, "info");

    try {
      if ("serial" in navigator) {
        const port = await pickBoardPort(webSerialPortRef.current, grantedBoardPorts, requestBoardPort);
        webSerialPortRef.current = port;
        logToTerminal(`[RETRIEVE] Target port: ${describePort(port)}.`, "info");

        if (mcu === "esp32") {
          logToTerminal("[RETRIEVE] Port selected. Preparing to read firmware from ESP32...", "info");
          const transport = new Transport(port, true);
          const term = {
            clean: () => { },
            writeLine: (data: string) => logToTerminal(`[RETRIEVE] ${data}`, "info"),
            write: (data: string) => logToTerminal(`[RETRIEVE] ${data}`, "info"),
          };
          const loader = new ESPLoader({ transport, baudrate: 115200, terminal: term });
          await loader.main();

          logToTerminal("[RETRIEVE] Reading 1MB of firmware from flash memory (address 0x10000)...", "info");

          try {
            const flashData = await loader.readFlash(0x10000, 1024 * 1024, (packet: Uint8Array, read: number, total: number) => {
              if (read % (1024 * 64) === 0) {
                logToTerminal(`[RETRIEVE] Progress: ${Math.round((read / total) * 100)}%`, "info");
              }
            });

            logToTerminal("[RETRIEVE] Firmware retrieved successfully! Downloading...", "success");

            const blob = new Blob([flashData as any], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "firmware_backup.bin";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            setRetrievedFirmware(flashData);
          } catch (readErr: any) {
            logToTerminal(`[RETRIEVE] Failed to read flash: ${readErr.message}`, "error");
          } finally {
            logToTerminal("[RETRIEVE] Rebooting microcontroller...", "info");
            try {
              await transport.setDTR(false);
              await transport.setRTS(true);
              await new Promise(r => setTimeout(r, 100));
              await transport.setDTR(false);
              await transport.setRTS(false);
              await new Promise(r => setTimeout(r, 50));
            } catch (e) { }
            await transport.disconnect();
          }

        } else {
          logToTerminal("[RETRIEVE] Reading firmware is only supported for ESP32 boards in this sandbox.", "error");
        }
      } else {
        logToTerminal("[RETRIEVE] Error: Web Serial API not supported in this browser.", "error");
      }
    } catch (err: any) {
      if (err.name === 'NotFoundError' || err.message?.includes("No port selected by the user") || err.message?.includes("User rejected")) {
        logToTerminal("[RETRIEVE] Port selection cancelled by user.", "info");
        return;
      }
      if (err.message?.includes("disallowed by permissions policy")) {
        logToTerminal("[RETRIEVE] Web Serial API is restricted in this preview frame. Please open the app in a new tab.", "error");
      } else {
        logToTerminal(`[RETRIEVE] Error: ${err.message}`, "error");
      }
    }
  };

  const handleSimulate = async () => {
    if (mcu !== "arduino") {
      logToTerminal("[SIMULATOR] Simulation for ESP32 requires advanced backend emulators like QEMU. Arduino simulation is ready.", "error");
      alert("Simulation for ESP32 requires an advanced emulator like QEMU.\n\nOther platforms like Wokwi use proprietary cloud instances for ESP32, and Cirkit Designer uses a custom open-source runner.\n\nFor this demonstration, let's stick to Arduino AVR simulation.");
      return;
    }
    logToTerminal("[SIMULATOR] Compiling for simulation...", "info");
    const compiledResult = await handleCompile();
    if (!compiledResult.success) return;
    const compiled = compiledResult.data;

    if (compiled.format !== "hex") {
      logToTerminal("[SIMULATOR] ERROR: AVR simulator requires Intel HEX format. ESP32 binary format is not supported.", "error");
      return;
    }

    logToTerminal("[SIMULATOR] Starting AVR8js engine...", "info");
    setIsSimulationActive(true);

    import("./lib/simulator").then((sim) => {
      const hexString = atob(compiled.binary);
      sim.startSimulation(hexString, (text) => {
        setTerminalLines((prev) => {
          const lines = [...prev];
          // Accumulate chars until we get a newline, then start a new line
          if (text === '\n' || text === '\r') {
            lines.push({ text: "", type: "serial", id: Date.now() + Math.random().toString(), timestamp: new Date().toLocaleTimeString() });
          } else if (lines.length > 0 && lines[lines.length - 1].type === "serial") {
            lines[lines.length - 1] = { ...lines[lines.length - 1], text: lines[lines.length - 1].text + text };
          } else {
            lines.push({ text, type: "serial", id: Date.now() + Math.random().toString(), timestamp: new Date().toLocaleTimeString() });
          }
          return lines;
        });
      });
    });
  };

  const handleFlash = async (binaryData?: any, overrideCode?: string): Promise<{ success: boolean, error?: string }> => {
    // Read through refs rather than the values this closure captured. Smart
    // Flash runs from the agent's response handler, whose closure predates a
    // USB connection made during that same request — so a board that was
    // plugged in and working reported "No board detected" once, then flashed
    // fine on the very next attempt.
    const board = detectedBoardRef.current;
    if (!board || !mcuPluggedInRef.current) {
      logToTerminal("[FLASH] ERROR: No board detected. Click 'Auto-Detect Board' first.", "error");
      return { success: false, error: "No board detected." };
    }

    // Release any active serial monitor locks before we do anything
    // Wait for the monitor's read loop to actually exit. Cancelling without
    // waiting left the stream locked, so the close() below rejected and the
    // flasher's open() then failed with "The port is already open".
    await stopSerialMonitor();
    if (activePortRef.current) {
      try { await activePortRef.current.close(); } catch (e) { }
      activePortRef.current = null;
    }

    // The project's board decides the toolchain and the binary. If the thing
    // actually plugged in is a different family, every downstream path is
    // wrong: AVR firmware will not run on an ESP32, and esptool's DTR/RTS
    // bootloader handshake means nothing to an ATmega. Refuse here, where the
    // cause is obvious, rather than failing later inside a flasher with an
    // error about control signals that says nothing about the real problem.
    if (detectedMcu && detectedMcu !== mcu) {
      logToTerminal(
        `[FLASH] Board mismatch — this project targets ${mcu.toUpperCase()} but a ${detectedMcu.toUpperCase()} board is plugged in.`,
        "error"
      );
      logToTerminal(
        `[FLASH] Nothing was flashed. Either switch this project to ${detectedMcu.toUpperCase()} in the board selector, or connect a ${mcu.toUpperCase()} board.`,
        "error"
      );
      setIsFlashing(false);
      return { success: false, error: `Board mismatch: project targets ${mcu.toUpperCase()}, connected board is ${detectedMcu.toUpperCase()}.` };
    }

    setIsFlashing(true);
    logToTerminal(`[FLASH] Initiating flash to ${board}...`, "info");

    const codeToFlash = overrideCode || code;
    // The monitor that follows must listen at the rate THIS sketch uses, even
    // when it is newer than the editor state this closure captured.
    monitorBaudRef.current = sketchBaudRate(codeToFlash);
    sketchOpensSerialRef.current = sketchOpensSerial(codeToFlash);
    sketchBaudKnownRef.current = sketchSerial(codeToFlash)?.baud != null;

    // Decide flash strategy:
    // - Firefox/Safari: backend PlatformIO CLI (no Web Serial in those browsers)
    // - Chrome + Arduino: STK500v1 in the browser (src/lib/avrFlash.ts)
    // - Chrome + ESP32: esptool-js in the browser
    //
    // Arduino used to fall through to the backend, which runs `pio run -t
    // upload` and looks for the board on the SERVER's USB ports. The server is
    // in a datacentre with no serial devices, so that path could never reach a
    // user's board — Arduino flashing simply did not work for anybody.
    if (!canReachBoard) {
      const { reason, advice } = describeSerialSupport();
      logToTerminal(`[FLASH] Cannot flash from this browser. ${reason}`, "error");
      logToTerminal(`[FLASH] ${advice}`, "info");
      setIsFlashing(false);
      return { success: false, error: `Cannot flash from this browser. ${advice}` };
    }

    if (mcu === "arduino") {
      let avrPort: any = null;
      let flashed = false;
      try {
        let compiled = binaryData;
        if (!compiled) {
          const compiledResult = await handleCompile(overrideCode);
          if (!compiledResult.success) { setIsFlashing(false); return { success: false, error: compiledResult.errorText || "Compile failed." }; }
          compiled = compiledResult.data;
        }
        if (!compiled?.binary) throw new Error("No firmware produced by the build.");

        avrPort = await pickBoardPort(webSerialPortRef.current, grantedBoardPorts, requestBoardPort);
        webSerialPortRef.current = avrPort;

        logToTerminal(`[FLASH] Target port: ${describePort(avrPort)}.`, "info");
        logToTerminal("[FLASH] Uploading to AVR board over Web Serial (STK500)...", "info");
        await flashAvr({
          hex: atob(compiled.binary),
          // From the compile response, so the flash parameters come from the
          // same board resolution that produced this binary.
          uploadProtocol: compiled.uploadProtocol,
          uploadSpeed: compiled.uploadSpeed,
          chip: compiled.chip,
          port: avrPort,
          onProgress: (m) => logToTerminal(`[FLASH] ${m}`, "info"),
        });

        logToTerminal("[FLASH] Upload complete — the board is running your code.", "success");
        setIsFlashing(false);
        flashed = true;
        return { success: true };
      } catch (err: any) {
        if (err?.code === "HELD_BY_PHONE_DRIVER") {
          phoneHeldBoardGuidance(err.usbVendorId, err.usbProductId).forEach((line, i) => logToTerminal(line, i === 0 ? "error" : "info"));
          setIsFlashing(false);
          return { success: false, error: "This phone will not release the board to the browser; use a CH340 or FTDI adapter (see the terminal)." };
        }
        logToTerminal(`[FLASH] ${err.message}`, "error");
        setIsFlashing(false);
        return { success: false, error: err.message };
      } finally {
        // Without this a failed attempt leaves the port claimed, and every
        // later flash in the same session fails for a different reason.
        if (avrPort) { try { await avrPort.close(); } catch { /* already closed */ } }
        // Show what the new sketch prints, as the ESP32 path always has. Only
        // once the port is closed above, so the monitor opens a free port.
        if (flashed && avrPort) void startWebSerialMonitor(avrPort);
      }
    }

    {
      // Chrome + ESP32: try Web Serial esptool-js
      let transport: any = null;
      try {
        // First compile
        let compiled = binaryData;
        if (!compiled) {
          const compiledResult = await handleCompile(overrideCode);
          if (!compiledResult.success) { setIsFlashing(false); return { success: false, error: compiledResult.errorText || "Compile failed." }; }
          compiled = compiledResult.data;
        }

        const port = await pickBoardPort(webSerialPortRef.current, grantedBoardPorts, requestBoardPort);
        webSerialPortRef.current = port;

        logToTerminal(`[FLASH] Target port: ${describePort(port)}.`, "info");
        logToTerminal("[FLASH] Using Web Serial API for ESP32 flashing...", "info");
        // esptool-js opens the port itself. If anything still holds it open —
        // board detection, or a previous attempt that failed mid-flight — that
        // open throws and surfaces as "Failed to connect with the device",
        // which points the user at their hardware instead of at the real cause.
        try { await port.close(); } catch { /* not open, the normal case */ }
        transport = new Transport(port, true);
        const term = {
          clean: () => { },
          writeLine: (data: string) => logToTerminal(`[FLASH] ${data}`, "info"),
          write: (data: string) => logToTerminal(`[FLASH] ${data}`, "info"),
        };

        /**
         * Put the chip in download mode in ONE line-state write.
         *
         * esptool's ClassicReset does setDTR(true) then setRTS(false) as two
         * separate writes. On a devkit's cross-coupled auto-reset circuit that
         * passes through a state where DTR and RTS are both high — neither EN
         * nor IO0 driven — so EN is released while IO0 is still high. A desktop
         * serial driver clears that glitch in microseconds and the capacitor on
         * EN never charges. Over WebUSB from a phone each write takes
         * milliseconds: EN fully rises and the chip boots the application
         * instead of the ROM loader.
         *
         * setSignals writes both lines at once, so going straight from (EN low)
         * to (IO0 low, EN released) never visits the glitch state.
         *
         * Handed to esptool as its classicReset rather than run by hand first.
         * Running it by hand meant opening the port here and letting esptool
         * open it again — which the WebUSB adapter tolerated (its open() is
         * re-entrant) and a real SerialPort refused outright with "The port is
         * already open". That is why ESP32 flashing worked on the phone and
         * broke on the desktop. esptool owns the port now; only the waveform
         * is ours.
         */
        const atomicClassicReset = (t: any, resetDelay: number) => ({
          reset: async () => {
            const set = (dtr: boolean, rts: boolean) =>
              t.device.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
            await set(false, false);
            await new Promise((r) => setTimeout(r, 50));
            await set(false, true);                        // EN low: held in reset
            await new Promise((r) => setTimeout(r, 120));
            await set(true, false);                        // IO0 low + EN released, one write
            await new Promise((r) => setTimeout(r, Math.max(50, resetDelay)));
            await set(false, false);                       // release both
          },
        });

        const loaderWithReset = new ESPLoader({
          transport,
          baudrate: 115200,
          terminal: term,
          resetConstructors: { classicReset: atomicClassicReset },
        } as any);

        try {
          await loaderWithReset.main();
        } catch (connectErr: any) {
          logToTerminal(`[FLASH] ${connectErr.message}. Last try — hold BOOT now.`, "info");
          logToTerminal("[FLASH] Hold the BOOT (or FLASH) button and keep holding it.", "info");
          await new Promise((r) => setTimeout(r, 3000));
          await loaderWithReset.main("no_reset");
        }

        // Convert base64 to Uint8Array for esptool-js writeFlash
        const base64ToUint8Array = (base64: string) => {
          const binaryString = atob(base64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          return bytes;
        };

        const fileArray: Array<{data: Uint8Array, address: number}> = [];
        if (compiled.bootloader) fileArray.push({ data: base64ToUint8Array(compiled.bootloader), address: 0x1000 });
        if (compiled.partitions) fileArray.push({ data: base64ToUint8Array(compiled.partitions), address: 0x8000 });
        if (compiled.boot_app0) fileArray.push({ data: base64ToUint8Array(compiled.boot_app0), address: 0xe000 });
        if (compiled.binary) fileArray.push({ data: base64ToUint8Array(compiled.binary), address: 0x10000 });

        await loaderWithReset.writeFlash({
          fileArray: fileArray,
          flashSize: "keep",
          flashMode: "keep",
          flashFreq: "keep",
          eraseAll: false,
          compress: true, // MUST be true in esptool-js 0.6.0
          reportProgress: (fileIndex: number, written: number, total: number) => {
            const progress = Math.round((written / total) * 100);
            logToTerminal(`[FLASH] Flashing block ${fileIndex + 1}: ${progress}%`, "info");
          }
        });

        // esptool's own after('hard_reset') is a no-op here: HardReset does
        // nothing but setRTS(false), which assumes RTS is still asserted from
        // the connect sequence — but ClassicReset ends with RTS already false.
        // No edge, no reset, so the chip stays in the ROM bootloader and the
        // freshly written sketch does not run until the board is power-cycled.
        // Drive a real reset: IO0 high so it boots the application, then pulse
        // EN low and release.
        logToTerminal("[FLASH] Resetting the board to run your code…", "info");
        try {
          await transport.setDTR(false);          // IO0 high -> normal boot
          await transport.setRTS(true);           // EN low  -> held in reset
          await new Promise((r) => setTimeout(r, 120));
          await transport.setRTS(false);          // EN high -> run the new sketch
        } catch (resetErr: any) {
          logToTerminal(`[FLASH] Could not auto-reset (${resetErr.message}). Press the EN/RST button to start your code.`, "info");
        }
        await transport.disconnect();
        transport = null;
        logToTerminal("==========================================================", "success");
        logToTerminal("[FLASH] SUCCESS: ESP32 flashed successfully via Web Serial!", "success");
        logToTerminal("==========================================================", "success");
        setIsFlashing(false);
        setIsSimulationActive(true);

        // Start reading serial data from the MCU
        startWebSerialMonitor(port);
        return { success: true };
      } catch (err: any) {
        setIsFlashing(false);
        if (transport) {
          try { await transport.disconnect(); } catch (e) {}
        }
        if (err.name === 'NotFoundError' || err.message?.includes("No port selected") || err.message?.includes("User rejected")) {
          logToTerminal("[FLASH] Port selection cancelled.", "info");
          return { success: false, error: "Port selection cancelled." };
        }
        // The backend fallback used to run here. It runs `pio run -t upload`
        // on the SERVER, which is a datacentre container with no USB, so it
        // could only ever fail with "Please specify upload_port" — burying the
        // real, actionable error under twenty seconds and a udev-rules notice.
        logToTerminal(`[FLASH] ${err.message}`, "error");
        logToTerminal(
          "[FLASH] The ESP32 did not enter download mode. Hold the BOOT (or FLASH) button, " +
          "press and release EN/RST, keep BOOT held for a second, then flash again. " +
          "If it still fails, unplug and replug the board, and close any serial monitor using the port.",
          "info"
        );
        setIsFlashing(false);
        return { success: false, error: err.message };
      }
    }
  };

  /**
   * Stop whatever monitor is running and give the port back.
   *
   * Web Serial refuses to close a port while its readable stream is locked by
   * a reader, so the reader has to be cancelled and its loop allowed to exit
   * first. Skipping that was how asking for the monitor a second time bricked
   * the port: close() rejected, open() threw "The port is already open", and
   * the error path then cleared the ref to the live reader still holding the
   * lock — after which nothing could release it and every subsequent flash
   * failed with the same error until the board was physically replugged.
   */
  const stopSerialMonitor = () => serializeMonitor(releaseSerialMonitor);

  /**
   * Run monitor starts and stops strictly one after another.
   *
   * Two starts can overlap: the post-flash monitor starts by itself and is not
   * awaited, and the agent's 'monitor' command arrives straight after it. When
   * they interleaved, one of them failed ("ReadableStream is locked", or the
   * port closed underneath it) and its error path then released the monitor
   * that was current — the OTHER start's healthy reader. The monitor said
   * INITIALIZED and then showed nothing, in the panel or the terminal.
   */
  const serializeMonitor = (op: () => Promise<void>): Promise<void> => {
    const run = monitorQueueRef.current.then(op, op);
    monitorQueueRef.current = run.catch(() => { /* each op reports its own errors */ });
    return run;
  };

  /** The body of stopSerialMonitor. Only ever called from inside the queue. */
  const releaseSerialMonitor = async () => {
    const reader = serialReaderRef.current;
    serialReaderRef.current = null;
    if (reader) {
      try { await reader.cancel(); } catch { /* already gone */ }
      try { reader.releaseLock(); } catch { /* cancel released it already */ }
    }
    const loop = monitorLoopRef.current;
    monitorLoopRef.current = null;
    if (loop) { try { await loop; } catch { /* the loop reports its own errors */ } }
  };

  /** The read loop itself. Runs until the reader is cancelled or the board goes. */
  const pumpSerialMonitor = async (reader: any) => {
    const decoder = new TextDecoder();

    // An ESP32 prints its ROM boot log at 74880 baud, so read at 115200 it is
    // unreadable bytes. Drop whatever arrives in that window so the monitor
    // opens on the sketch's own output.
    const bootLogUntil = Date.now() + 600;
    // Mojibake also comes from a partial UTF-8 sequence or a byte that is not
    // text at all; neither belongs on screen.
    const printable = (t: string) =>
      t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, "");

    // Assemble lines. A USB-serial bridge delivers whatever happens to be in
    // its buffer — often a single byte — and logging each delivery as its own
    // entry turned one printed line into a column of single characters. Hold
    // text until a newline, and flush anything left after a pause so a sketch
    // that never prints a newline still shows up.
    let pending = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const emit = (line: string) => {
      const clean = printable(line).trim();
      if (clean) logToTerminal(clean, "serial");
    };
    const scheduleFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { const t = pending; pending = ""; emit(t); }, 250);
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (Date.now() < bootLogUntil) continue;   // still inside the boot burst
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";               // keep the unterminated tail
        for (const line of lines) emit(line);
        if (pending) scheduleFlush(); else if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      }
    } catch (e: any) {
      // A cancel() during read() lands here; so does an unplug.
      if (!/cancel/i.test(e?.message || "")) {
        logToTerminal(`[SERIAL ERROR] ${e.message}`, "error");
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      try { reader.releaseLock(); } catch { /* already released */ }
      if (serialReaderRef.current === reader) serialReaderRef.current = null;
    }
  };

  // Web Serial monitor for Chrome (after esptool-js flash)
  const startWebSerialMonitor = (port: any): Promise<void> => {
    wantSerialMonitorRef.current = true;
    // Queued, so a start never interleaves with another start or a stop.
    return serializeMonitor(() => takePortForMonitor(port));
  };

  /** The body of startWebSerialMonitor. Only ever called from inside the queue. */
  const takePortForMonitor = async (port: any) => {
    // Hand the port back before taking it again. Asking for the monitor while
    // one is already running is normal — the post-flash monitor starts by
    // itself, and the user can then ask for it too.
    await releaseSerialMonitor();
    try {
      // Close and reopen unconditionally. Skipping the open when a stream
      // already existed meant the USB-serial bridge kept whatever baud the
      // flasher left it at, and every byte after that was misframed — which
      // is what filled the monitor with stray characters on a phone.
      try { await port.close(); } catch { /* not open, which is fine */ }
      const baud = monitorBaudRef.current;
      await port.open({ baudRate: baud });
      activePortRef.current = port;

      if (mcu === "esp32") {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      }

      const reader = port.readable.getReader();
      serialReaderRef.current = reader;
      // Announced only once the port is genuinely open and read: the old order
      // printed "INITIALIZED" and then an error on the very next line.
      // Say which board and where the rate came from, so a wrong rate is
      // obvious rather than a silent, empty monitor.
      const boardName = (detectedBoardRef.current || "").replace(/^Connected:\s*/, "").replace(/\s*\(VID.*$/, "")
        || (mcu === "esp32" ? "ESP32" : "Arduino");
      logToTerminal(
        !sketchOpensSerialRef.current
          ? `[SERIAL MONITOR INITIALIZED @ ${baud} BAUD] ${boardName} — your sketch never calls Serial.begin(), so nothing will appear until it does.`
          : sketchBaudKnownRef.current
            ? `[SERIAL MONITOR INITIALIZED @ ${baud} BAUD] ${boardName} — the rate your sketch opens Serial at.`
            : `[SERIAL MONITOR INITIALIZED @ ${baud} BAUD] ${boardName} — your sketch's Serial.begin() rate could not be read, so ${baud} is assumed. If nothing appears, write the rate as a number, e.g. Serial.begin(9600).`,
        "serial"
      );
      monitorLoopRef.current = pumpSerialMonitor(reader);
    } catch (e: any) {
      logToTerminal(`[SERIAL ERROR] ${e.message}`, "error");
      // Never leave the port open-but-locked: the flasher needs it next.
      // Inside the queue, so what this releases is only what this start took.
      await releaseSerialMonitor();
    }
  };

  // Backend PlatformIO flash — works in ALL browsers, supports ALL MCUs
  const handleBackendFlash = async (codeToFlash: string): Promise<{ success: boolean, error?: string }> => {
    logToTerminal(`[FLASH] Using the Joint-Agent Engine to compile and upload (${mcu.toUpperCase()})...`, "info");
    let result: { success: boolean, error?: string } = { success: false, error: "Unknown flash error." };
    try {
      const response = await authedApiRequest("/api/flash", {
        body: {
          code: codeToFlash,
          mcu,
          boardId,
          port: selectedPortPathRef.current || undefined
        }
      });
      const data = await response.json();

      if (data.success) {
        logToTerminal("==========================================================", "success");
        logToTerminal(`[FLASH] SUCCESS: ${mcu.toUpperCase()} flashed!`, "success");
        logToTerminal("==========================================================", "success");
        if (data.stdout) {
          const lines = data.stdout.split('\n').slice(-10);
          lines.forEach((l: string) => l.trim() && logToTerminal(l.trim(), "info"));
        }

        // Start serial monitor via backend WebSocket
        if (selectedPortPathRef.current) {
          logToTerminal("[SERIAL] Starting serial monitor via backend...", "info");
          connectSerialWs();
          await authedApiRequest("/api/serial/connect", { body: { path: selectedPortPathRef.current, baudRate: 115200 } });
        }
        result = { success: true };
      } else {
        logToTerminal(`[FLASH] Upload failed: ${data.error}`, "error");
        if (data.stderr) logToTerminal(data.stderr.slice(-500), "error");
        result = { success: false, error: data.error + (data.stderr ? "\n" + data.stderr : "") };
      }
    } catch (err: any) {
      logToTerminal(`[FLASH] Backend flash error: ${err.message}`, "error");
      result = { success: false, error: err.message };
    }
    setIsFlashing(false);
    return result;
  };


  const handleInstrumentDebug = async (breakpoints: string, watchVars: string) => {
    const requestProjectId = currentProjectIdRef.current;
    logToTerminal(`[DEBUGGER] Instrumenting code at lines ${breakpoints} to watch ${watchVars}...`, "info");
    const prompt = `Instrument the following C++ code for an ${mcu}. Add Serial breakpoints (e.g. while(!Serial.available()) { delay(10); } Serial.read();) at lines ${breakpoints}. Before the block, print "[BREAKPOINT] Line X" over Serial, and print the values of variables: ${watchVars} in the format "[WATCH] varName=value". Also add basic profiling using micros() around the main loop or key functions and print "[PROFILE] funcName=123us". Ensure Serial.begin(115200); is in setup. Output ONLY the raw instrumented C++ code in a markdown block.`;

    setIsDebugging(true);
    setLeftTab('agent');

    let streamedText = "";
    let projectUpdateCode: string | null = null;

    try {
      const result = await streamChatEndpoint("/api/ai/chat", {
        messages: [
          { role: "user", content: prompt + "\n\nCODE:\n" + code }
        ],
        mcu,
        boardId,
        chatMode: "implement"
      }, (event) => {
        if (event.type === "text_delta") streamedText += event.text;
        else if (event.type === "project_update") projectUpdateCode = event.projectUpdate?.code || null;
      });

      if (result.blocked) {
        setQuotaBlockInfo(result.info);
        setIsUpgradeModalOpen(true);
        logToTerminal("[DEBUGGER] AI tokens used for now. They refill soon; see the countdown in the chat.", "error");
        setIsDebugging(false);
        return;
      }
      if (result.error) throw new Error(result.error);

      const stillSameProject = currentProjectIdRef.current === requestProjectId;
      if (projectUpdateCode) {
        if (stillSameProject) setCode(projectUpdateCode);
        logToTerminal("[DEBUGGER] Code instrumented. Compiling and flashing...", "success");
        await handleFlash(undefined, projectUpdateCode);
      } else {
        // fallback regex extract
        const match = streamedText.match(/\x60\x60\x60(?:cpp)?\n([\s\S]*?)\x60\x60\x60/);
        if (match) {
          if (stillSameProject) setCode(match[1]);
          logToTerminal("[DEBUGGER] Code instrumented. Compiling and flashing...", "success");
          await handleFlash(undefined, match[1]);
        } else {
          logToTerminal("[DEBUGGER] Failed to extract code from AI response.", "error");
        }
      }
    } catch (e: any) {
      logToTerminal(`[DEBUGGER] Instrumentation failed: ${e.message}`, "error");
    }
    setIsDebugging(false);
  };

  const handleDebugStep = async () => {
    if (activePortRef.current) {
      logToTerminal("[DEBUGGER] Sending STEP command...", "info");
      const writer = activePortRef.current.writable.getWriter();
      await writer.write(new TextEncoder().encode("S"));
      writer.releaseLock();
    }
  };

  const handleDebugContinue = async () => {
    if (activePortRef.current) {
      logToTerminal("[DEBUGGER] Sending CONTINUE command...", "info");
      const writer = activePortRef.current.writable.getWriter();
      await writer.write(new TextEncoder().encode("C"));
      writer.releaseLock();
      setDebugState(prev => ({ ...prev, activeLine: null }));
    }
  };

  const closeTour = (completed: boolean) => {
    setTourOpen(false);
    if (user) {
      try { localStorage.setItem(tourKey(user.uid), completed ? "done" : "skipped"); } catch { /* storage off */ }
    }
    // Back to where building starts.
    if (isNarrowRef.current && appMode === "agentic") setMobilePane("agent");
  };

  const toPane = (pane: MobilePane) => () => { if (isNarrowRef.current) setMobilePane(pane); };
  const tourSteps: TourStep[] = [
    {
      title: "Welcome to Joint-Agent",
      body: <>Describe a project, and the agent writes the firmware, compiles it and flashes it to your board. Here's a quick look around.</>,
    },
    ...(isNarrow ? [{
      target: '[data-tour="mobile-nav"]',
      title: "Three sections",
      body: <>Workspace, Agent and Code. Tap them here, or swipe left and right, to move between them.</>,
    }] : []),
    {
      target: '[data-tour="mode"]',
      title: "Agent-Mode or Manual-Mode",
      body: <><b>Agent-Mode</b>: tell the AI what to build. <b>Manual-Mode</b>: write the code yourself, with Ask AI to help.</>,
    },
    {
      target: '[data-tour="agent-input"]',
      before: toPane("agent"),
      title: "Describe what you want",
      body: <>Type it, or tap the mic and say it (up to 2 minutes). Use <b>+</b> to add a photo of your wiring.</>,
    },
    {
      target: '[data-tour="connect"]',
      title: "Connect your board",
      body: isNarrow
        ? <>Plug your Arduino or ESP32 into your phone with a USB OTG cable, then tap here to connect it.</>
        : <>Plug your Arduino or ESP32 in over USB, then click <b>Detect Board</b> to connect it.</>,
    },
    {
      target: '[data-tour="smart-flash"]',
      before: toPane("agent"),
      title: "Smart Flash",
      body: <>Compiles your code and flashes it to the board in one tap. On PRO it also fixes compile errors for you.</>,
    },
    {
      target: "#code-editor-panel",
      before: toPane("editor"),
      title: "Your code",
      body: <>The agent's code lands here, ready to edit. Tap <b>Ask AI</b> to fix it, explain it or add comments.</>,
    },
    {
      target: '[data-tour="dock"]',
      before: toPane("editor"),
      title: "Terminal and serial monitor",
      body: <>Build and flash progress shows in the terminal. Open the Serial Monitor or Plotter to see what your board prints.</>,
    },
    {
      target: '[data-tour="sidebar"]',
      before: toPane("files"),
      title: "Projects, plugins and your plan",
      body: <>Save and open projects, add plugins, and tap your name for your usage and plan. You can replay this tour from there.</>,
    },
    {
      title: "You're ready",
      body: appMode === "agentic"
        ? <>Try a first project, or describe your own in the Agent chat.</>
        : <>Write your sketch in the editor, or switch to Agent-Mode and let the AI write it.</>,
    },
  ];

  /**
   * Agent-Mode's Ask AI on the code: turns a quick choice into a request to
   * the agent, which already sees the whole sketch. "Fix errors" carries the
   * last compile error. Always built, never planned: these are quick edits.
   * On a phone the agent's reply is on the Agent tab, so that is where it goes.
   */
  const handleAskAi = ({ action, question, selection }: AskAiRequest) => {
    const lines = selection ? `\n\n\`\`\`cpp\n${selection.slice(0, 4000)}\n\`\`\`` : "";
    let request: string;
    if (action === "fix") {
      const err = lastCompileErrorRef.current;
      request = err
        ? `Fix the compile errors in the sketch${selection ? ", starting with these lines" : ""}. The compiler said:\n\n\`\`\`\n${err.slice(-1500)}\n\`\`\`${lines}`
        : `Check the sketch${selection ? ", especially these lines," : ""} for errors and fix any you find.${lines}`;
    } else if (action === "explain") {
      request = selection
        ? `Explain what these lines do, step by step, in plain words.${lines}`
        : "Explain what this sketch does, step by step, in plain words.";
    } else if (action === "comment") {
      request = selection
        ? `Add clear comments to these lines explaining what they do and why. Don't change what the code does.${lines}`
        : "Add clear comments to the sketch explaining what each part does and why. Don't change what the code does.";
    } else {
      request = `${question}${lines}`;
    }
    if (isNarrowRef.current) setMobilePane("agent");
    handleSendMessage(request, "implement");
  };

  const handleDebugCode = async (actualError?: string, overrideCode?: string, autoDebugRun?: string): Promise<{ success: boolean, code?: string, blocked?: boolean, info?: QuotaBlockedInfo }> => {
    const requestProjectId = currentProjectIdRef.current;
    let resultCode = overrideCode || code;
    let resultSuccess = false;
    let resultBlocked = false;
    let resultInfo: QuotaBlockedInfo | undefined;
    setIsDebugging(true);
    logToTerminal("[AI AGENT] Analysing code structure and syntax rules...", "info");

    try {
      const result = await callAiEndpoint("/api/ai/debug", {
        code: overrideCode || code,
        error: actualError || "Compilation check request. Scan for syntax risks and optimize memory allocation.",
        mcu,
        boardId,
        // A PRO Smart Flash run that started inside the allowance may finish.
        ...(autoDebugRun ? { autoDebugRun } : {}),
      });

      if (!result.ok) {
        if (result.blocked) {
          resultBlocked = true;
          resultInfo = result.info;
          setQuotaBlockInfo(result.info);
          setIsUpgradeModalOpen(true);
          logToTerminal("[AI AGENT] AI tokens used for now. They refill soon; see the countdown in the chat.", "error");
        } else {
          throw new Error(result.error);
        }
      } else {
        if (currentProjectIdRef.current === requestProjectId) {
          setCode(result.data.code);
        } else {
          logToTerminal("[AI AGENT] Fix arrived after you switched projects — not applying it here.", "info");
        }
        resultCode = result.data.code;
        resultSuccess = true;
        logToTerminal("==========================================================", "success");
        logToTerminal("[AI AGENT] Successfully resolved potential code issues!", "success");
        logToTerminal("==========================================================", "success");
      }
    } catch (err: any) {
      logToTerminal(`[AI AGENT ERROR] Analysis interrupted: ${err.message || err}`, "error");
    } finally {
      setIsDebugging(false);
    }
    return { success: resultSuccess, code: resultBlocked ? undefined : resultCode, blocked: resultBlocked, info: resultInfo };
  };

  // Smart Flash: autonomously compile -> AI-debug -> recompile (looped) -> flash.
  // If no board is connected, prompts for one (must be called from a user gesture,
  // e.g. a button click, since requestPort() requires it).
  const handleSmartFlash = async (overrideCode?: string) => {
    if (isSmartFlashing) return;
    let currentCode = overrideCode ?? code;

    if (!mcuPluggedInRef.current) {
      logToTerminal("[SMART FLASH] No board connected. Requesting device selection...", "info");
      await handleAutoDetect();
    }

    if (!mcuPluggedInRef.current) {
      logToTerminal("[SMART FLASH] Board connection required. Connect your device and click 'Smart Flash' again.", "error");
      return;
    }

    setIsSmartFlashing(true);
    logToTerminal("==========================================================", "info");
    logToTerminal("[SMART FLASH] Starting autonomous compile -> debug -> flash cycle...", "info");
    logToTerminal("==========================================================", "info");

    // Everything below runs inside try/finally so the button cannot be left
    // reading "Flashing...". Unplugging the board mid-flash makes a USB
    // transfer throw, and that escaped every early return here — leaving the
    // control stuck until the page was reloaded. NOT a mobile-only fault: the
    // same path runs on desktop, it is just harder to trip there.
    try {

    const MAX_ATTEMPTS = 5;
    let attempt = 0;
    // Names this run's auto-debug rounds, so once one is under way it can
    // finish even if the PRO allowance runs out partway.
    const autoDebugRun = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let compileResult = await handleCompile(currentCode);

    // A build that compiled but produced no artifact is an infrastructure
    // fault, not a code fault. Rewriting the user's code cannot fix it, so the
    // loop used to burn five AI rounds and five lots of the user's tokens
    // "resolving" code that was never broken.
    if (!compileResult.success && compileResult.compileSucceeded) {
      logToTerminal("[SMART FLASH] Stopped — the code compiled cleanly, so auto-debug cannot help. This is a build-server issue; please try again or report it.", "error");
      setIsSmartFlashing(false);
      return;
    }

    // Refused by the Free compile limit: nothing was built, so there is no
    // error in the code to fix, and saying "fix the error above" would send
    // the user hunting for a bug that does not exist.
    if (!compileResult.success && compileResult.limited) {
      const { reason, resetAt } = compileResult.limited;
      logToTerminal(`[SMART FLASH] Stopped: you've used ${reason === "day" ? "today's" : "this window's"} free compiles.${resetAt ? ` More in ${formatWait(resetAt)}.` : ""} Your code wasn't checked, so there's nothing to fix. Get PRO for unlimited compiles.`, "error");
      setIsSmartFlashing(false);
      return;
    }

    // Auto-debug is a PRO feature. The Free plan stops at the compile error;
    // Ask AI on the code and the agent can still be asked to fix it.
    if (!compileResult.success && tierRef.current === "free") {
      logToTerminal("[SMART FLASH] Compile failed. Auto-debug is part of PRO: tap Ask AI on the code, or ask the agent, to fix the error above. Get PRO to have Smart Flash fix and retry automatically.", "error");
      setIsSmartFlashing(false);
      return;
    }

    while (!compileResult.success && attempt < MAX_ATTEMPTS) {
      attempt++;
      logToTerminal(`[SMART FLASH] Compile error detected. AI auto-debug attempt ${attempt}/${MAX_ATTEMPTS}...`, "error");
      const debugResult = await handleDebugCode(compileResult.errorText, currentCode, autoDebugRun);
      if (!debugResult.code) {
        if (debugResult.blocked) {
          const pause = debugResult.info;
          logToTerminal(pause?.reason === "cycle"
            ? `[SMART FLASH] Stopped: this month's PRO allowance is used. Auto-debug picks up again ${pause.resetAt ? `in ${formatWait(pause.resetAt)}` : "on your next billing date"}.`
            : `[SMART FLASH] Stopped: this ${WINDOW_HOURS}-hour window's AI allowance is used. Auto-debug picks up again ${pause?.resetAt ? `in ${formatWait(pause.resetAt)}` : "when it refills"}.`, "error");
        } else {
          logToTerminal("[SMART FLASH] AI debugger returned no fix. Aborting.", "error");
        }
        setIsSmartFlashing(false);
        return;
      }
      currentCode = debugResult.code;
      const missingBefore = compileResult.missingLibrary;
      compileResult = await handleCompile(currentCode);
      // Still missing the same library: it has to be added, and more AI
      // rounds would only spend the user's allowance rewriting nothing.
      if (!compileResult.success && compileResult.missingLibrary && compileResult.missingLibrary === missingBefore) {
        logToTerminal("[SMART FLASH] Stopped: this project needs a library that isn't added yet. Open Libraries above main.cpp to add it, then Smart Flash again.", "error");
        setIsSmartFlashing(false);
        return;
      }
    }

    if (!compileResult.success) {
      logToTerminal(`[SMART FLASH] Could not resolve compile errors after ${MAX_ATTEMPTS} attempts. Giving up.`, "error");
      setIsSmartFlashing(false);
      return;
    }

    logToTerminal("[SMART FLASH] Compile succeeded. Flashing to device...", "success");
    const flashResult = await handleFlash(compileResult.data, currentCode);

    if (flashResult?.success) {
      logToTerminal("[SMART FLASH] Autonomous flash cycle completed successfully!", "success");
    } else {
      logToTerminal(`[SMART FLASH] Flash step failed: ${flashResult?.error || "Unknown error"}.`, "error");
    }
    } catch (err: any) {
      logToTerminal(`[SMART FLASH] Stopped unexpectedly: ${err?.message || err}.`, "error");
    } finally {
      setIsSmartFlashing(false);
      setIsFlashing(false);
    }
  };

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
      logToTerminal("[AI AGENT] Request aborted by user.", "error");
    }
  };

  const handleSendMessage = async (text: string, modeOverride?: "plan" | "implement", images?: string[]) => {
    const requestProjectId = currentProjectIdRef.current;
    const newUserMsg: ChatMessage = {
      id: Math.random().toString(),
      role: "user",
      content: text,
      timestamp: Date.now(),
      ...(images?.length ? { images } : {}),
    };

    const newMessages = [...chatMessages, newUserMsg];
    setChatMessages(newMessages);
    setIsLoading(true);

    abortControllerRef.current = new AbortController();

    logToTerminal(`[AI AGENT] Processing request: "${text.slice(0, 30)}..."`, "info");

    // Plan Mode is a PRO feature; everyone else's request is built.
    const effectiveMode = planModeAvailable ? (modeOverride || chatMode) : "implement";

    // Streamed: the assistant bubble is created empty on the first chunk
    // (replacing the "Agent is thinking" indicator) and grows as text
    // arrives, instead of the UI sitting frozen until the full response is
    // ready. A project_update/command event replaces whatever text streamed
    // in ahead of it with the fixed confirmation copy, matching how the
    // non-streaming version always preferred that canned message over any
    // model preamble on a tool-call turn.
    const assistantMsgId = Math.random().toString();
    let assistantContent = "";
    let projectUpdate: any = null;
    let pendingCommand: string | null = null;
    // Whether this request folded the earlier conversation into a summary:
    // the one thing that makes the conversation genuinely smaller.
    let compactedThisRequest = false;
    let started = false;
    const ensureStarted = () => {
      if (started) return;
      started = true;
      setIsLoading(false);
      setChatMessages((prev) => [...prev, {
        id: assistantMsgId,
        role: "assistant",
        content: assistantContent || "Done.",
        timestamp: Date.now(),
        // effectiveMode, not chatMode: pressing "Proceed to Implement" sends
        // modeOverride "implement" while deliberately leaving the session in
        // plan mode, so chatMode is still "plan" here and the implementation
        // reply was being tagged as a plan — which put the Proceed button back
        // underneath it after the user had already pressed it.
        isPlanResponse: effectiveMode === "plan"
      }]);
    };
    const updateAssistantMsg = (patch: Partial<ChatMessage>) => {
      setChatMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, ...patch } : m)));
    };

    try {
      const result = await streamChatEndpoint(
        "/api/ai/chat",
        // Messages folded into a summary are still shown but no longer sent:
        // the summary stands in for them.
        // The sketch in the editor goes along, so the agent changes it rather
        // than writing a new one blind.
        { messages: newMessages.filter((m) => !m.compacted), mcu, boardId, chatMode: effectiveMode, currentCode: codeRef.current },
        (event) => {
          if (event.type === "text_delta") {
            assistantContent += event.text;
            ensureStarted();
            updateAssistantMsg({ content: assistantContent });
          } else if (event.type === "tier") {
            setTier(event.tier);
          } else if (event.type === "context") {
            // The model counts the whole request, and a plan-mode request goes
            // out without the tool definitions and with a shorter instruction
            // than a build request — so the same conversation read 11%, then
            // 8% on the next plan question. A conversation only grows, so the
            // meter keeps its high-water mark and only drops when the earlier
            // part is summarized (or the project changes, which clears it).
            const next = { used: event.used, limit: event.limit };
            setContextUsage((prev) =>
              !compactedThisRequest && prev && prev.limit === next.limit && next.used < prev.used ? prev : next
            );
          } else if (event.type === "context_compacted") {
            compactedThisRequest = true;
            // The server folded these messages into a summary before answering.
            // Keep them on screen, mark them, and put the summary after them.
            const folded = new Set<string>(event.compactedIds || []);
            setChatMessages((prev) => {
              const marked = prev.map((m) => (folded.has(m.id) || m.isContextSummary) && !m.compacted ? { ...m, compacted: true } : m);
              let at = 0;
              marked.forEach((m, i) => { if (m.compacted) at = i + 1; });
              const summaryMsg: ChatMessage = {
                id: Math.random().toString(),
                role: "assistant",
                content: event.summary,
                timestamp: Date.now(),
                isContextSummary: true,
              };
              return [...marked.slice(0, at), summaryMsg, ...marked.slice(at)];
            });
            logToTerminal("[AI AGENT] Conversation was nearly full — the earlier part is now summarized, so the agent can keep going.", "info");
          } else if (event.type === "project_update") {
            assistantContent = event.text;
            projectUpdate = event.projectUpdate;
            ensureStarted();
            updateAssistantMsg({ content: assistantContent, suggestedProjectUpdate: projectUpdate });
          } else if (event.type === "command") {
            // A command event can arrive with no text at all, which rendered as
            // an empty bubble with no explanation of what just happened.
            assistantContent = event.text?.trim()
              ? event.text
              : "Running that in the workspace…";
            pendingCommand = event.command;
            ensureStarted();
            updateAssistantMsg({ content: assistantContent });
          } else if (event.type === "tool_progress") {
            // Emitted while the model streams tool-call arguments. Without it
            // the user stares at a spinner for the whole of code generation.
            ensureStarted();
            if (!assistantContent) updateAssistantMsg({ content: event.text });
          }
        },
        { signal: abortControllerRef.current.signal }
      );

      if (result.blocked) {
        setQuotaBlockInfo(result.info);
        setIsUpgradeModalOpen(true);
        return;
      }
      if (result.error) throw new Error(result.error);

      ensureStarted(); // defensive: stream completed with zero events

      if (currentProjectIdRef.current !== requestProjectId) {
        logToTerminal("[AI AGENT] Response arrived after you switched projects — not applying it here.", "info");
      } else {
        if (projectUpdate && appMode === "agentic") {
          handleApplyProjectUpdate(projectUpdate);
          // Auto-applied: on a phone, show the code it just wrote. Only here —
          // a plan, an answer or a command leaves the user in the chat.
          if (isNarrowRef.current && projectUpdate.code) {
            setActiveTab("code");
            setMobilePane("editor");
          }
        }

        if (projectUpdate?.code && effectiveMode === "implement") {
          if (mcuPluggedInRef.current) {
            handleSmartFlash(projectUpdate.code);
          } else {
            logToTerminal("[SMART FLASH] Board not connected. Click 'Smart Flash' next to the agent chat once your device is plugged in.", "info");
          }
        }
      }

      if (pendingCommand) {
        setIsTerminalOpen(true);
        handleExecuteCommand(pendingCommand, true);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setChatMessages((prev) => [
          ...prev,
          { id: Math.random().toString(), role: "assistant", content: "Generation stopped.", timestamp: Date.now() }
        ]);
      } else {
        setChatMessages((prev) => [
          ...prev,
          { id: Math.random().toString(), role: "assistant", content: `Error: ${err.message}`, timestamp: Date.now() }
        ]);
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  // Refreshed every render, so a send started from an older closure uses
  // the current conversation, not the one that closure captured.
  sendMessageRef.current = handleSendMessage;

  const handleApplyProjectUpdate = (update: {
    code?: string;
    description?: string;
    components?: SchematicComponent[];
    connections?: SchematicConnection[];
  }) => {
    if (update.code) setCode(update.code);
    if (update.description) setDescription(update.description);
    if (update.components) {
      setComponents(augmentComponents(update.components as SchematicComponent[]));
    }
    if (update.connections) setConnections(update.connections);

    logToTerminal("[AI AGENT] Workspace Blueprints and Source Code Updated.", "success");
  };

  /** "Open Code" on a reply: put that code in the editor and, on a phone,
   *  go to it with the terminal down to a strip so the code gets the screen. */
  const handleOpenCode = (codeToOpen?: string) => {
    if (codeToOpen) handleApplyProjectUpdate({ code: codeToOpen });
    setActiveTab("code");
    if (isNarrow) {
      setCompactDock(true);
      setMobilePane("editor");
    }
  };

  const DEFAULT_DESCRIPTION = "A standard flashing LED circuit safely wired through a 220 Ohm current-limiting resistor. Ideal for validating MCU state loops.";

  // Free accounts hold FREE_PROJECT_LIMIT projects at once. Nothing is
  // deleted to fit: past it, a new project waits for a free slot. Only a
  // known Free account is limited, so a slow or failed plan check never
  // blocks a PRO user.
  const [projectLimitOpen, setProjectLimitOpen] = useState(false);
  const atProjectLimit = async (fresh = false): Promise<boolean> => {
    if (!user || accountTier !== "free") return false;
    if (!fresh && recentProjects.length < FREE_PROJECT_LIMIT) return false;
    try {
      const list = await listProjects(user.uid);
      setRecentProjects(list);
      return list.length >= FREE_PROJECT_LIMIT;
    } catch {
      return false;
    }
  };
  const openNewProject = async () => {
    if (await atProjectLimit()) { setProjectLimitOpen(true); return; }
    setShowNewProjectModal(true);
  };

  const handleCreateProject = async (name: string, board: BoardInfo, codeOverride?: string) => {
    if (!user) return;
    // Counted again at the moment of creating: another tab or device may
    // have added one since the form opened.
    if (await atProjectLimit(true)) {
      setShowNewProjectModal(false);
      setImportedFileCode(null);
      setImportedFileName("");
      setProjectLimitOpen(true);
      return;
    }
    handleStopGeneration(); // cancel any in-flight agent request from the project being left
    const initialCode = codeOverride || INITIAL_CODE;
    try {
      const newId = await createProject(user.uid, name, {
        code: initialCode,
        description: DEFAULT_DESCRIPTION,
        components: INITIAL_COMPONENTS,
        connections: INITIAL_CONNECTIONS,
        mcu: board.family,
        boardId: board.id,
      });
      skipNextAutosaveRef.current = true;
      setCurrentProjectId(newId);
      setCurrentProjectName(name);
      setCode(initialCode);
      setDescription(DEFAULT_DESCRIPTION);
      setComponents(INITIAL_COMPONENTS);
      setConnections(INITIAL_CONNECTIONS);
      setMcu(board.family);
      setBoardId(board.id);
      setChatMessages([]); // a brand new project starts with no conversation
      setContextUsage(null);
      // The terminal is per-project too: build output, flash logs and serial
      // traffic from the previous board were carrying over and reading as if
      // they belonged to the project just created.
      setTerminalLines([]);
      setShowNewProjectModal(false);
      setShowProjectsBrowser(false);
      logToTerminal(`[PROJECT] Created "${name}" for ${board.name}.`, "success");
    } catch (err: any) {
      logToTerminal(`[PROJECT] Failed to create project: ${err.message}`, "error");
    } finally {
      setImportedFileCode(null);
      setImportedFileName("");
    }
  };

  const handleImportFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportedFileCode(String(reader.result || ""));
      setImportedFileName(file.name.replace(/\.ino$/i, ""));
      void (async () => {
        if (await atProjectLimit()) {
          setImportedFileCode(null);
          setImportedFileName("");
          setProjectLimitOpen(true);
          return;
        }
        setShowNewProjectModal(true);
      })();
    };
    reader.onerror = () => {
      logToTerminal("[PROJECT] Could not read the selected .ino file.", "error");
    };
    reader.readAsText(file);
  };

  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);

  /** Delete from the sidebar. Deleting the OPEN project has to clear the
   *  workspace too, or the editor keeps showing a project that no longer
   *  exists and the next autosave silently recreates it. */
  const handleDeleteProject = async (projectId: string, name: string) => {
    if (!user) return;
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    setDeletingProjectId(projectId);
    try {
      await deleteProject(user.uid, projectId);
      if (projectId === currentProjectId) {
        skipNextAutosaveRef.current = true;
        setCurrentProjectId(null);
        setCurrentProjectName("");
        setChatMessages([]);
        setContextUsage(null);
        setTerminalLines([]);
      }
      logToTerminal(`[PROJECT] Deleted "${name}".`, "info");
      await refreshRecentProjects();
    } catch (err: any) {
      logToTerminal(`[PROJECT] Could not delete "${name}": ${err.message}`, "error");
    } finally {
      setDeletingProjectId(null);
    }
  };

  const refreshRecentProjects = React.useCallback(async () => {
    if (!user) { setRecentProjects([]); return; }
    setLoadingRecent(true);
    try {
      setRecentProjects(await listProjects(user.uid));
    } catch {
      // Non-fatal: the sidebar list is a convenience, Browse projects still works.
    } finally {
      setLoadingRecent(false);
      setRecentFetched(true);
    }
  }, [user]);

  // Re-fetch when the user changes or they switch project — switching is the
  // moment a project is created, renamed or saved, so this covers all of them.
  useEffect(() => { refreshRecentProjects(); }, [refreshRecentProjects, currentProjectId]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/boards")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const b of d.boards || []) m.set(b.id, b.name);
        setBoardNames(m);
      })
      .catch(() => { /* labels degrade to the chip family, which is still useful */ });
    return () => { cancelled = true; };
  }, []);

  // Wait for the first project fetch before deciding what the welcome dialog
  // should offer — opening it early would show "start your first project" to
  // someone who has twelve.
  useEffect(() => {
    if (!user) {
      welcomeShownForRef.current = null;
      setRecentFetched(false);
      setShowWelcome(false);
      return;
    }
    if (!recentFetched || welcomeShownForRef.current === user.uid) return;
    welcomeShownForRef.current = user.uid;
    // Someone with no projects yet, who has not had the tour here, is new:
    // show them around instead of asking what to open.
    let seen = true;
    try { seen = !!localStorage.getItem(tourKey(user.uid)); } catch { /* storage off: skip the tour */ }
    if (recentProjects.length === 0 && !seen) {
      setTourOpen(true);
      return;
    }
    setShowWelcome(true);
  }, [user, recentFetched]);

  const handleOpenProject = async (projectId: string) => {
    if (!user) return;
    handleStopGeneration(); // cancel any in-flight agent request from the project being left
    setIsLoadingProject(true);
    try {
      const data = await getProject(user.uid, projectId);
      if (!data) {
        logToTerminal("[PROJECT] That project could not be found.", "error");
        return;
      }
      skipNextAutosaveRef.current = true;
      setCurrentProjectId(projectId);
      setCurrentProjectName(data.name);
      setCode(data.code || INITIAL_CODE);
      setDescription(data.description || DEFAULT_DESCRIPTION);
      setComponents(augmentComponents(data.components || []));
      setConnections(data.connections || []);
      setMcu(data.mcu || "esp32");
      setBoardId(data.boardId || (data.mcu === "arduino" ? "uno" : "esp32dev"));
      // Restore this project's own conversation. Previously this cleared the
      // panel, so reopening a project lost every question and answer that led
      // to the code — the user got a finished sketch with no history.
      setChatMessages((data.messages || []) as any);
      setContextUsage(null);
      setShowProjectsBrowser(false);
      logToTerminal(`[PROJECT] Opened "${data.name}".`, "success");
    } catch (err: any) {
      logToTerminal(`[PROJECT] Failed to open project: ${err.message}`, "error");
    } finally {
      setIsLoadingProject(false);
    }
  };

  const handleRenameProject = async (newName: string) => {
    const trimmed = newName.trim() || "Untitled Project";
    setCurrentProjectName(trimmed);
    if (user && currentProjectId) {
      try {
        await renameProject(user.uid, currentProjectId, trimmed);
      } catch (err: any) {
        logToTerminal(`[PROJECT] Failed to rename: ${err.message}`, "error");
      }
    }
  };

  // Autosave: debounce writes to Firestore whenever the open project's code,
  // schematic, or MCU changes. Skipped for one tick right after we've just
  // loaded/created a project, so loading data doesn't immediately re-save it.
  useEffect(() => {
    if (!user || !currentProjectId) return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setSaveStatus("saving");
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await updateProject(user.uid, currentProjectId, {
          code, description, components, connections, mcu,
          // Stored with the project so reopening it restores the conversation
          // that produced the code, not just the code.
          messages: trimMessagesForStorage(chatMessages as any),
        });
        setSaveStatus("saved");
      } catch (err: any) {
        logToTerminal(`[PROJECT] Autosave failed: ${err.message}`, "error");
        setSaveStatus("idle");
      }
    }, 1500);
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // chatMessages included so a conversation that produced no code change
    // still persists — asking a question and getting an answer is exactly the
    // history the user wants back, and without this it was never written.
  }, [code, description, components, connections, mcu, chatMessages, currentProjectId, user]);

  const handleSubscribe = async () => {
    if (!user?.email) return;
    setIsSubscribing(true);
    try {
      const cfgRes = await fetch("/api/paystack/public-config");
      const cfg = await cfgRes.json();
      if (!cfg.configured || !window.PaystackPop) {
        logToTerminal("[BILLING] Payments aren't configured yet. Check back soon.", "error");
        setIsSubscribing(false);
        return;
      }
      window.PaystackPop.setup({
        key: cfg.publicKey,
        email: user.email,
        plan: cfg.planCode,
        metadata: { uid: user.uid },
        // Paystack's inline script rejects an async callback outright — it checks
        // the function's constructor name, and an async function reports
        // "AsyncFunction", which fails validation with "Attribute callback must
        // be a valid function". So this stays a plain function and starts the
        // verification separately; Paystack never awaits it anyway.
        callback: (response) => {
          void (async () => {
          try {
            const idToken = await user.getIdToken();
            const verifyRes = await fetch("/api/paystack/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
              body: JSON.stringify({ reference: response.reference })
            });
            if (verifyRes.ok) {
              clearLastKnownBlock();
              setQuotaBlockInfo(null);
              setIsUpgradeModalOpen(false);
              setIsPlansOpen(false);
              setAccountTier("pro");
              logToTerminal("[BILLING] Subscription active. Thanks for upgrading!", "success");
            } else {
              const err = await verifyRes.json().catch(() => ({}));
              logToTerminal(`[BILLING] Payment verification failed: ${err.error || "Unknown error."}`, "error");
            }
          } catch (e: any) {
            logToTerminal(`[BILLING] Payment verification failed: ${e.message}`, "error");
          } finally {
            setIsSubscribing(false);
          }
          })();
        },
        onClose: () => setIsSubscribing(false)
      }).openIframe();
    } catch (e: any) {
      logToTerminal(`[BILLING] Could not start checkout: ${e.message}`, "error");
      setIsSubscribing(false);
    }
  };

  /** Give the board back and forget it: the header's Disconnect on every layout. */
  const forgetBoard = () => {
    // Give the port back. The monitor that starts after a flash held it
    // open, so Detect Board's own open() then failed with "The port is
    // already open" until the cable was pulled.
    void (async () => {
      await stopSerialMonitor();
      if (activePortRef.current) {
        try { await activePortRef.current.close(); } catch { /* already closed */ }
        activePortRef.current = null;
      }
    })();
    setDetectedBoard(null);
    setDetectedBoardId(null);
    setDetectedMcu(null);
    setMcuPluggedIn(false);
    webSerialPortRef.current = null;
    logToTerminal("[USB] Connection disconnected/forgotten. You can scan again.", "info");
  };

  // A phone section slides in from the side it came from. Sections mount
  // fresh on every switch, so the animation plays once per change.
  const paneEnterClass = isNarrow && paneDirection ? (paneDirection === "next" ? "pane-in-next" : "pane-in-prev") : "";

  /** Agent-Mode / Manual-Mode. Full width on a phone, where it has its own row. */
  const modeSwitcher = (fullWidth: boolean) => (
    <div data-tour="mode" className={`flex bg-[var(--bg-root)] p-[3px] rounded-lg border border-[var(--border-main)] ${fullWidth ? "w-full" : "shrink-0"}`}>
      {([
        { mode: "agentic" as const, label: "Agent-Mode", Icon: Bot, on: "bg-[var(--accent-primary-soft)] text-[var(--accent-primary)]" },
        { mode: "manual" as const, label: "Manual-Mode", Icon: PenTool, on: "bg-[var(--accent-secondary-soft)] text-[var(--accent-secondary)]" },
      ]).map(({ mode, label, Icon, on }) => (
        <button
          key={mode}
          onClick={() => setAppMode(mode)}
          aria-pressed={appMode === mode}
          className={`flex items-center justify-center gap-1.5 rounded-md font-semibold tracking-wide transition-all duration-200 ${
            fullWidth ? "flex-1 min-h-[40px] text-[13px]" : "px-4 min-h-[32px] text-[12px]"
          } ${appMode === mode ? `${on} shadow-sm` : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
        >
          <Icon size={fullWidth ? 16 : 14} />
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="app-shell h-full bg-[var(--bg-root)] text-[var(--text-main)] flex flex-col antialiased overflow-hidden">
      {/* Universal Header — Glassmorphism */}
      <header className="border-b border-[var(--border-main)] header-glass shrink-0 z-30">
        <div className="h-12 px-2 sm:px-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          {isNarrow ? (
            // On a phone the plan takes the logo's place: a way up for free
            // accounts, a quiet badge for PRO ones — and nothing until the
            // server has said which, so PRO never flashes an upgrade.
            accountTier === null ? null : isPro ? (
              <span className="pro-badge h-9 px-1 text-[15px] select-none" title="You're on PRO">
                <Zap size={16} fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
                PRO
              </span>
            ) : (
              <button
                onClick={() => setIsPlansOpen(true)}
                className="btn-lift flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-[11px] font-bold text-white shadow-md whitespace-nowrap"
                style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-glow)" }}
              >
                <Rocket size={15} className="rocket-blaze" /> Get PRO
              </button>
            )
          ) : (
            <div className="flex items-center gap-2.5 logo-accent cursor-default select-none">
              <img src="/logo.png" alt="Joint-Agent IDE" className="w-7 h-7 rounded-lg shrink-0 shadow-md" />
              <div className="flex flex-col">
                <h1 className="font-display font-bold text-[13px] text-[var(--text-main)] tracking-wide leading-tight flex items-center gap-1.5">
                  Joint-Agent <span className="gradient-text">IDE</span>
                  <span className="text-[8px] font-mono font-semibold text-[var(--text-subtle)] bg-[var(--bg-surface)] border border-[var(--border-main)] rounded px-1 py-px leading-none">
                    v1.0
                  </span>
                </h1>
                <p className="text-[8px] text-[var(--text-subtle)] font-mono tracking-[0.2em] uppercase">IoT · Blockchain · AI</p>
              </div>
            </div>
          )}

          {!isNarrow && <div className="h-5 w-px bg-[var(--border-main)] mx-1"></div>}

          {!isNarrow && modeSwitcher(false)}
        </div>

        {/* Global Controls */}
        <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 pr-1">

          {currentProjectId && (
            <div className="flex items-center gap-1.5 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-2 py-1 min-w-0">
              <FileCode size={12} className="text-[var(--text-muted)] shrink-0" />
              <input
                value={currentProjectName}
                onChange={(e) => setCurrentProjectName(e.target.value)}
                onBlur={(e) => handleRenameProject(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                className="bg-transparent border-none outline-none text-[11px] font-medium text-[var(--text-main)] w-full max-w-36 sm:max-w-36 min-w-0 py-1.5 sm:py-0"
                placeholder="Project name"
                title="Click to rename this project"
              />
              <span className="text-[8px] text-[var(--text-subtle)] shrink-0 hidden sm:inline">
                {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : ""}
              </span>
            </div>
          )}

          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="toolbar-btn p-2.5 sm:p-1.5 rounded-lg text-[var(--text-muted)] shrink-0"
            title={theme === "light" ? "Switch to Dark Mode" : "Switch to Light Mode"}
          >
            {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
          </button>

          {isNarrow ? (
            // A square that never grows: the project name keeps its room.
            // Connected, it turns green and pulses; a tap shows which board
            // and offers to disconnect it.
            <div data-tour="connect" className="relative shrink-0">
              {(detectedBoard && mcuPluggedIn) ? (
                <button
                  onClick={() => setIsBoardMenuOpen((open) => !open)}
                  className="status-online w-9 h-9 flex items-center justify-center rounded-lg border border-green-500/50 bg-green-500/15 text-green-400 transition"
                  aria-label={`Board connected: ${detectedBoard}`}
                  title={detectedBoard}
                >
                  <Usb size={16} />
                </button>
              ) : (
                <button
                  onClick={handleAutoDetect}
                  className="w-9 h-9 flex items-center justify-center rounded-lg border border-[var(--border-main)] bg-[var(--bg-surface)] text-[var(--text-muted)] transition"
                  aria-label="Detect board"
                  title="Detect board"
                >
                  <Usb size={16} />
                </button>
              )}
              {isBoardMenuOpen && detectedBoard && mcuPluggedIn && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsBoardMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-64 z-50 bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-lg p-3 animate-slide-up" style={{ boxShadow: 'var(--shadow-panel)' }}>
                    <div className="flex items-start gap-2">
                      <span className="mt-1 w-2 h-2 rounded-full bg-green-500 status-online shrink-0" />
                      <p className="text-[11px] font-mono text-green-400 leading-snug break-words">
                        {detectedBoard.replace(/^Connected:\s*/, "")}
                      </p>
                    </div>
                    <button
                      onClick={() => { setIsBoardMenuOpen(false); forgetBoard(); }}
                      className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-md border border-[var(--border-main)] text-xs text-[var(--text-muted)] hover:text-red-400 hover:border-red-500/40 transition"
                    >
                      <X size={12} /> Disconnect
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (detectedBoard && mcuPluggedIn) ? (
            // Just the icon, green and pulsing. Hovering (or tabbing to it)
            // shows which board, with a small × that disconnects it. The
            // details float below rather than widening the header, so nothing
            // beside it moves.
            <div data-tour="connect" className="group relative shrink-0">
              <button
                className="status-online w-8 h-8 flex items-center justify-center rounded-lg border border-green-500/50 bg-green-500/15 text-green-400 transition"
                aria-label={`Board connected: ${detectedBoard}`}
              >
                <Usb size={15} />
              </button>
              <div className="absolute right-0 top-full pt-1.5 z-50 hidden group-hover:block group-focus-within:block">
                <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)] pl-3 pr-1.5 py-1.5" style={{ boxShadow: 'var(--shadow-panel)' }}>
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                  <span className="text-[10px] font-mono text-green-400">{detectedBoard.replace(/^Connected:\s*/, "")}</span>
                  <button
                    onClick={forgetBoard}
                    className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition"
                    aria-label="Disconnect board"
                    title="Disconnect"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              data-tour="connect"
              onClick={handleAutoDetect}
              className="btn-lift flex items-center gap-1.5 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] px-2.5 py-1 rounded-lg border border-[var(--border-main)] text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] transition shrink-0"
            >
              <Cpu size={12} className="text-[var(--accent-secondary)]" />
              <span>Detect Board</span>
            </button>
          )}

          </div>
        </div>
        </div>

        {/* On a phone the modes get a row of their own: labelled, full width,
            and big enough to hit without aiming. */}
        {isNarrow && <div className="px-2 pb-2">{modeSwitcher(true)}</div>}
      </header>

      {/* Main Workspace Layout with Resizable Panels */}
      <main
        className="flex-1 flex overflow-hidden"
        onTouchStart={handleMainTouchStart}
        onTouchEnd={handleMainTouchEnd}
        onTouchCancel={() => { swipeRef.current = null; }}
      >
        <PanelGroup orientation="horizontal">

          {/* Left Sidebar: File Explorer */}
          {(!isNarrow || mobilePane === "files") && (
          <Panel defaultSize={15} minSize={1}>
            <aside data-tour="sidebar" className={`w-full h-full bg-[var(--bg-panel)] border-r border-[var(--border-main)] flex flex-col shrink-0 ${paneEnterClass}`}>
              {/* The account, above the projects: who is signed in, and the
                  menu with usage, the plan and sign-out. */}
              {user && (
                <div className="p-1.5 border-b border-[var(--border-main)] shrink-0 flex items-center gap-1">
                  {/* Name and plan share a line when the sidebar has room; on a
                      narrow desktop sidebar the plan wraps under the name
                      rather than squeezing it out of sight. */}
                  <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-1">
                  <button
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setProfileMenuAt({ left: r.left + 4, top: r.bottom + 4 });
                      handleOpenProfileMenu();
                    }}
                    className="min-w-0 max-w-full flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-[var(--bg-hover)] transition text-left"
                  >
                    {user.photoURL ? (
                      <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-7 h-7 rounded-full shrink-0" />
                    ) : (
                      <span
                        className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0"
                        style={{ background: 'var(--gradient-hero)' }}
                      >
                        {(user.displayName || user.email || '?').charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 block text-[12px] font-semibold text-[var(--text-main)] truncate">
                      {user.displayName || user.email?.split("@")[0] || "Your account"}
                    </span>
                  </button>
                  {/* Beside the name: the way up for a free account, the plan
                      itself for a PRO one — never an upgrade offer to PRO. */}
                  {isPro ? (
                    <span className="pro-badge text-[13px] px-1.5 shrink-0 select-none" title="You're on PRO">
                      <Zap size={13} fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
                      PRO
                    </span>
                  ) : accountTier !== null ? (
                    <button
                      onClick={() => setIsPlansOpen(true)}
                      className="flex items-center gap-1 px-1.5 py-1.5 rounded-md text-[11px] font-extrabold text-[var(--accent-primary)] hover:bg-[var(--accent-primary-soft)] transition shrink-0 whitespace-nowrap"
                    >
                      <Rocket size={12} className="rocket-blaze" /> Upgrade to Pro
                    </button>
                  ) : null}
                  </div>
                  <button
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setProfileMenuAt({ left: r.left - 180, top: r.bottom + 4 });
                      handleOpenProfileMenu();
                    }}
                    className="p-2 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)] transition shrink-0"
                    aria-label="Account menu"
                  >
                    <MoreVertical size={14} />
                  </button>
                </div>
              )}

              <div className="flex-1 overflow-y-auto terminal-scrollbar">
              <div className="px-3 py-2.5 text-[9px] uppercase text-[var(--text-subtle)] font-bold tracking-[0.2em] border-b border-[var(--border-main)]">
                Projects
              </div>
              <div className="py-1.5 space-y-0.5">
                <button
                  onClick={() => void openNewProject()}
                  className="w-[calc(100%-0.75rem)] text-left mx-1.5 px-2 py-1.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] cursor-pointer transition rounded-md"
                >
                  <Plus size={13} className="text-[var(--accent-primary)]" />
                  <span>New project</span>
                  {accountTier === "free" && recentFetched && (
                    <span className="ml-auto text-[10px] text-[var(--text-subtle)] tabular-nums" title={`The Free plan holds ${FREE_PROJECT_LIMIT} projects`}>
                      {Math.min(recentProjects.length, FREE_PROJECT_LIMIT)}/{FREE_PROJECT_LIMIT}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setShowProjectsBrowser(true)}
                  className="w-[calc(100%-0.75rem)] text-left mx-1.5 px-2 py-1.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] cursor-pointer transition rounded-md"
                >
                  <FolderOpen size={13} className="text-[var(--accent-secondary)]" />
                  <span>Browse projects</span>
                </button>
                <button
                  onClick={() => importFileInputRef.current?.click()}
                  className="w-[calc(100%-0.75rem)] text-left mx-1.5 px-2 py-1.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] cursor-pointer transition rounded-md"
                >
                  <Upload size={13} className="text-[var(--text-muted)]" />
                  <span>Import Arduino Project</span>
                </button>
                <button
                  onClick={() => setGithubOpen(true)}
                  className="w-[calc(100%-0.75rem)] text-left mx-1.5 px-2 py-1.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] cursor-pointer transition rounded-md"
                >
                  <Github size={13} className="text-[var(--text-muted)]" />
                  <span>Push to GitHub</span>
                </button>
                <input
                  ref={importFileInputRef}
                  type="file"
                  accept=".ino"
                  onChange={handleImportFileSelected}
                  className="hidden"
                />
              </div>

              {/* Plugins: integrations that extend a project, in one place. */}
              <div className="border-t border-[var(--border-main)] p-2">
                <button
                  onClick={() => setIsPluginsOpen((open) => !open)}
                  aria-expanded={isPluginsOpen}
                  className="btn-lift w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium rounded-md transition border border-[var(--border-main)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
                >
                  <Puzzle size={13} className="text-[var(--accent-secondary)]" /> Plugins
                  {walletState.connected && <span className="w-1.5 h-1.5 rounded-full bg-green-500" title="Wallet connected" />}
                  <ChevronDown size={12} className={`ml-auto transition-transform ${isPluginsOpen ? "rotate-180" : ""}`} />
                </button>
                {isPluginsOpen && (
                  <div className="mt-1.5 ml-2 pl-2 border-l border-[var(--border-main)] space-y-1.5 animate-slide-up">
                <button
                  onClick={() => setIsWalletModalOpen(true)}
                  className={`btn-lift w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium rounded-md transition border ${walletState.connected
                      ? "bg-green-500/8 border-green-500/20 text-green-400 hover:bg-green-500/15"
                      : "border-[var(--border-main)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
                    }`}
                >
                  <Wallet size={13} className={walletState.connected ? "text-green-400" : "text-[var(--accent-secondary)]"} />
                  {walletState.connected ? "Wallet Connected" : "Web3 Oracle"}
                </button>

                <button
                  onClick={() => setIsEdgeImpulseModalOpen(true)}
                  className="btn-lift w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium rounded-md transition border border-[var(--border-main)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
                >
                  <Cloud size={13} className="text-purple-400" /> Edge Impulse
                </button>
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--border-main)] p-1.5 space-y-0.5">
                <button onClick={() => { setCompactDock(false); setIsTerminalOpen(!isTerminalOpen); if (isNarrow) { setMobilePane("editor"); if (!isTerminalOpen) setMobileDockTab("terminal"); } }} className={`w-full flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-md transition ${isTerminalOpen ? 'bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] font-medium' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'}`}>
                  <TerminalIcon size={13} /> Terminal
                </button>
                <button onClick={() => setWebPreviewOpen(true)} className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-md transition text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]">
                  <Globe size={13} /> Web Preview
                </button>
                <button onClick={() => { setCompactDock(false); setIsSerialMonitorOpen(!isSerialMonitorOpen); if (isNarrow) { setMobilePane("editor"); if (!isSerialMonitorOpen) setMobileDockTab("serial"); } }} className={`w-full flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-md transition ${isSerialMonitorOpen ? 'bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] font-medium' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'}`}>
                  <Monitor size={13} /> Serial Monitor
                </button>
                <button onClick={() => { setCompactDock(false); setIsSerialPlotterOpen(!isSerialPlotterOpen); if (isNarrow) { setMobilePane("editor"); if (!isSerialPlotterOpen) setMobileDockTab("plotter"); } }} className={`w-full flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-md transition ${isSerialPlotterOpen ? 'bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] font-medium' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'}`}>
                  <Activity size={13} /> Serial Plotter
                </button>
                <FeedbackWidget variant="sidebar" boardId={boardId} mcu={mcu} />
              </div>

                {/* Recent work, last: below the tools and Feedback, where the
                    list can run as long as it needs without pushing them away. */}
                <div className="pt-3 pb-2 border-t border-[var(--border-main)]">
                  <div className="px-3.5 pb-1.5 text-[9px] uppercase text-[var(--text-subtle)] font-bold tracking-[0.2em]">
                    Recent
                  </div>

                  {loadingRecent && recentProjects.length === 0 && (
                    <div className="px-3.5 py-1.5 text-[11px] text-[var(--text-subtle)]">Loading…</div>
                  )}

                  {!loadingRecent && recentProjects.length === 0 && (
                    <p className="px-3.5 py-1.5 text-[10px] leading-relaxed text-[var(--text-subtle)]">
                      Projects you save appear here.
                    </p>
                  )}

                  {recentProjects.slice(0, 12).map((p) => {
                    const isOpen = p.id === currentProjectId;
                    return (
                      <div key={p.id} className="relative group flex items-center">
                      <button
                        onClick={() => { if (!isOpen) handleOpenProject(p.id); }}
                        title={`${p.name} — ${boardNames.get(p.boardId) || (p.mcu || "").toUpperCase()}`}
                        className={`w-[calc(100%-0.75rem)] text-left mx-1.5 px-2 py-1.5 flex items-center gap-2 text-[11px] rounded-md transition ${
                          isOpen
                            ? "bg-[var(--bg-hover)] text-[var(--text-main)]"
                            : "text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] cursor-pointer"
                        }`}
                      >
                        <FileCode
                          size={13}
                          className={isOpen ? "text-[var(--accent-primary)] shrink-0" : "text-[var(--text-subtle)] shrink-0"}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{p.name}</span>
                          {/* Which board this project targets. Without it a
                              list of names gives no clue whether "Blink" was
                              built for an Uno or an ESP32. */}
                          <span className="block truncate text-[9px] text-[var(--text-subtle)] leading-tight">
                            {boardNames.get(p.boardId) || (p.mcu || "").toUpperCase()}
                          </span>
                        </span>
                        {isOpen && (
                          <span className="text-[8px] uppercase tracking-wider text-[var(--accent-primary)] shrink-0 mr-5">
                            open
                          </span>
                        )}
                      </button>
                      {/* A sibling, not a child: a button inside a button is
                          invalid and the click would not reach it. Always
                          visible on touch, where there is no hover. */}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id, p.name); }}
                        disabled={deletingProjectId === p.id}
                        title={`Delete ${p.name}`}
                        className="absolute right-2.5 p-1 rounded text-[var(--text-subtle)] hover:text-red-400 hover:bg-red-500/10 transition opacity-100 sm:opacity-0 sm:group-hover:opacity-100 disabled:opacity-50"
                      >
                        {deletingProjectId === p.id
                          ? <Loader2 size={11} className="animate-spin" />
                          : <Trash2 size={11} />}
                      </button>
                      </div>
                    );
                  })}

                  {recentProjects.length > 12 && (
                    <button
                      onClick={() => setShowProjectsBrowser(true)}
                      className="w-[calc(100%-0.75rem)] text-left mx-1.5 px-2 py-1.5 text-[10px] text-[var(--text-subtle)] hover:text-[var(--text-main)] transition rounded-md"
                    >
                      View all {recentProjects.length}…
                    </button>
                  )}
                </div>
              </div>
            </aside>
          </Panel>
          )}

          {!isNarrow && <PanelResizeHandle className="panel-separator w-[3px] bg-[var(--border-main)] hover:bg-[var(--accent-primary)] transition-all duration-200 cursor-col-resize z-10" />}

          {/* Center: Agent Chat (Only in Agentic Mode) */}
          {appMode === "agentic" && (!isNarrow || mobilePane === "agent") && (
            <>
              <Panel defaultSize={55} minSize={1}>
                <div className={`w-full h-full bg-[var(--bg-panel)] flex flex-col min-w-0 ${paneEnterClass}`}>
                  <div className="flex-1 relative overflow-hidden">
                    <div className="absolute inset-0 z-10">
                      <AgentChat
                        messages={chatMessages}
                        onSendMessage={handleSendMessage}
                        isLoading={isLoading}
                        mcu={mcu}
                        onApplyUpdate={handleApplyProjectUpdate}
                        onOpenCode={handleOpenCode}
                        chatMode={planModeAvailable ? chatMode : "implement"}
                        setChatMode={setChatMode}
                        planModeAvailable={planModeAvailable}
                        mcuPluggedIn={mcuPluggedIn}
                        onStopGeneration={handleStopGeneration}
                        isSmartFlashing={isSmartFlashing}
                        contextUsage={contextUsage}
                        pause={quotaBlockInfo ? { free: quotaBlockInfo.tier === "free", reason: quotaBlockInfo.reason ?? null, wait: pauseWait } : null}
                        onUpgrade={() => setIsPlansOpen(true)}
                        onSmartFlash={() => {
                          // Smart Flash is disabled until a board connects and
                          // enables the instant it does — the same instant the
                          // device chooser closes. On Android the tap that
                          // confirmed the chooser can land on the page as well,
                          // and a reconnect then started a compile and flash
                          // nobody asked for. Ignore taps in that window.
                          if (Date.now() - boardConnectedAtRef.current < 1500) {
                            logToTerminal("[SMART FLASH] Ignored a tap that landed as the board connected. Tap Smart Flash again to flash.", "info");
                            return;
                          }
                          handleSmartFlash();
                        }}
                        onQuotaBlocked={(info) => { setQuotaBlockInfo(info); setIsUpgradeModalOpen(true); }}
                      />
                    </div>
                  </div>
                </div>
              </Panel>
              {!isNarrow && <PanelResizeHandle className="panel-separator w-[3px] bg-[var(--border-main)] hover:bg-[var(--accent-primary)] transition-all duration-200 cursor-col-resize z-10" />}
            </>
          )}

          {/* Right/Center: Editor & Terminal */}
          {(!isNarrow || mobilePane === "editor") && (
          <Panel defaultSize={appMode === "agentic" ? 30 : 85} minSize={1} className={paneEnterClass}>
            <PanelGroup orientation="vertical">
              <Panel defaultSize={isTerminalOpen || isSerialMonitorOpen || isSerialPlotterOpen ? (isNarrow && compactDock ? "78%" : 70) : 100} minSize={1}>
                {/* Editor Area */}
                <div className="w-full h-full flex flex-col min-h-0 bg-[var(--bg-root)]">
                  {/* Tabs */}
                  <div className="flex bg-[var(--bg-panel)] border-b border-[var(--border-main)]">
                    <button
                      onClick={() => setActiveTab("code")}
                      className={`relative px-4 py-2 text-[11px] font-medium flex items-center gap-2 transition-all ${activeTab === "code"
                          ? "text-[var(--text-main)] tab-active"
                          : "text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
                        }`}
                    >
                      <Code size={13} className={activeTab === "code" ? "text-[var(--accent-primary)]" : ""} />
                      <span className="font-mono">main.cpp</span>
                    </button>
                    <button
                      onClick={() => setActiveTab("schematic")}
                      className={`relative px-4 py-2 text-[11px] font-medium flex items-center gap-2 transition-all ${activeTab === "schematic"
                          ? "text-[var(--text-main)] tab-active"
                          : "text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
                        }`}
                    >
                      <Layers size={13} className={activeTab === "schematic" ? "text-[var(--accent-secondary)]" : ""} />
                      <span className="font-mono">schematic.view</span>
                    </button>
                  </div>

                  {/* Tab Content */}
                  <div className="flex-1 relative overflow-hidden">
                    <div className={`absolute inset-0 ${activeTab === "code" ? "z-10" : "z-0 opacity-0 pointer-events-none"}`}>
                      <CodeEditor
                        code={code}
                        setCode={setCode}
                        onCompile={() => handleCompile()}
                        onFlash={() => handleFlash()}
                        onDebug={() => handleDebugCode()}
                        isCompiling={isCompiling}
                        isFlashing={isFlashing}
                        isDebugging={isDebugging}
                        autoDetectedMcu={(detectedBoard && mcuPluggedIn) ? detectedBoard : null}
                        onAutoDetect={handleAutoDetect}
                        appMode={appMode}
                        onAskAi={handleAskAi}
                        askAiBusy={isLoading}
                        onOpenLibraries={() => setIsLibrariesOpen(true)}
                      />
                    </div>
                    <div className={`absolute inset-0 ${activeTab === "schematic" ? "z-10" : "z-0 opacity-0 pointer-events-none"}`}>
                      <SchematicViewer
                        mcu={mcu}
                        components={components}
                        connections={connections}
                        isSimulationActive={isSimulationActive}
                        isCompiling={isCompiling}
                        isFlashing={isFlashing}
                        appMode={appMode}
                        setComponents={setComponents}
                        setConnections={setConnections}
                      />
                    </div>
                  </div>
                </div>
              </Panel>

              {(isTerminalOpen || isSerialMonitorOpen || isSerialPlotterOpen) && (
                <>
                  <PanelResizeHandle className="panel-separator h-[3px] bg-[var(--border-main)] hover:bg-[var(--accent-primary)] transition-all duration-200 cursor-row-resize z-10" />
                  <Panel defaultSize={isNarrow ? (compactDock ? "22%" : 42) : 30} minSize={1}>
                    <div data-tour="dock" className="w-full h-full bg-[var(--bg-panel)] flex flex-col min-h-0 min-w-0">
                      {isNarrow && openDocks.length > 1 && (
                        <div className="flex shrink-0 border-b border-[var(--border-main)] bg-[var(--bg-panel)]">
                          {openDocks.map((id) => (
                            <button
                              key={id}
                              onClick={() => setMobileDockTab(id)}
                              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-[10px] font-display uppercase tracking-wider border-b-2 transition ${
                                activeDock === id
                                  ? "text-[var(--accent-primary)] border-[var(--accent-primary)]"
                                  : "text-[var(--text-muted)] border-transparent"
                              }`}
                            >
                              {id === "terminal" ? <TerminalIcon size={12} /> : id === "serial" ? <Monitor size={12} /> : <Activity size={12} />}
                              {id === "terminal" ? "Terminal" : id === "serial" ? "Monitor" : "Plotter"}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex-1 flex min-h-0 min-w-0">
                      {isTerminalOpen && showsDock("terminal") && (
                        <div className="flex-1 min-w-0 h-full border-r border-[var(--border-main)] last:border-r-0">
                          <Terminal
                            lines={terminalLines}
                            onExecuteCommand={handleExecuteCommand}
                            onClear={() => setTerminalLines([])}
                            onClose={() => setIsTerminalOpen(false)}
                          />
                        </div>
                      )}

                      {isSerialMonitorOpen && showsDock("serial") && (
                        <div className="flex-1 min-w-0 h-full border-r border-[var(--border-main)] last:border-r-0 bg-[var(--bg-root)] flex flex-col font-mono text-xs shadow-lg">
                          <div className="bg-[var(--bg-panel)] border-b border-[var(--border-main)] px-4 py-2.5 flex items-center justify-between shrink-0 select-none">
                            <div className="flex items-center gap-2">
                              <Monitor size={14} className="text-green-500" />
                              <span className="font-display font-medium text-[11px] text-[var(--text-main)] uppercase tracking-wider">
                                Serial Monitor
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => { void reconnectSerialMonitor(); }}
                                className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]"
                                title="Reconnect the board and restart streaming"
                              >
                                Reconnect <RefreshCw size={12} />
                              </button>
                              <button
                                onClick={() => setAutoScrollSerial(!autoScrollSerial)}
                                className={`flex items-center gap-1 text-[10px] transition px-1.5 py-0.5 rounded ${autoScrollSerial ? 'text-green-500 bg-green-500/10' : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]'}`}
                                title={autoScrollSerial ? "Auto-Scroll: ON" : "Auto-Scroll: OFF"}
                              >
                                Auto-scroll
                              </button>
                              <button
                                onClick={() => {
                                  const text = terminalLines.filter(l => l.type === "serial").map(l => monitorText(l.text)).join('\n');
                                  navigator.clipboard.writeText(text);
                                }}
                                className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]"
                                title="Copy Output"
                              >
                                Copy <Copy size={12} />
                              </button>
                              <button
                                onClick={() => setTerminalLines(prev => prev.filter(l => l.type !== "serial"))}
                                className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]"
                                title="Clear Screen"
                              >
                                Clear <X size={12} />
                              </button>
                              <button onClick={() => setIsSerialMonitorOpen(false)} className="text-[var(--text-muted)] hover:text-red-500 transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]" title="Delete Serial Monitor">
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>
                          <div ref={serialMonitorRef} className="flex-1 p-4 overflow-y-auto space-y-1.5 leading-normal terminal-scrollbar select-text bg-[var(--bg-root)] text-[var(--term-serial)]">
                            {terminalLines.filter(line => line.type === "serial").map((line) => (
                              <div key={line.id} className="flex items-start gap-1.5">
                                <span className="text-[10px] text-[var(--text-muted)] select-none font-mono mt-0.5 shrink-0">{line.timestamp}</span>
                                <pre className="whitespace-pre-wrap font-mono flex-1">{monitorText(line.text)}</pre>
                              </div>
                            ))}
                            {terminalLines.filter(line => line.type === "serial").length === 0 && (
                              <div className="text-[var(--text-muted)] text-center py-8 text-[11px]">
                                No serial output yet.
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {isSerialPlotterOpen && showsDock("plotter") && (
                        <div className="flex-1 min-w-0 h-full bg-[var(--bg-root)] flex flex-col font-mono text-xs shadow-lg">
                          <div className="bg-[var(--bg-panel)] border-b border-[var(--border-main)] px-4 py-2.5 flex items-center justify-between shrink-0 select-none">
                            <div className="flex items-center gap-2">
                              <Activity size={14} className="text-purple-500" />
                              <span className="font-display font-medium text-[11px] text-[var(--text-main)] uppercase tracking-wider">
                                Serial Plotter
                              </span>
                            </div>
                            <button onClick={() => setIsSerialPlotterOpen(false)} className="text-[var(--text-muted)] hover:text-red-500 transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]">
                              <X size={12} />
                            </button>
                          </div>
                          <div className="flex-1 p-4 bg-[var(--bg-root)] min-h-0">
                            {plotterData.length === 0 ? (
                              <div className="h-full flex items-center justify-center text-[var(--text-muted)]">
                                No numeric serial data found. Try printing numbers.
                              </div>
                            ) : (
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={plotterData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
                                  <XAxis dataKey="index" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} stroke="var(--border-main)" />
                                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} stroke="var(--border-main)" />
                                  <Tooltip
                                    contentStyle={{ backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-main)', borderRadius: '4px', fontSize: '12px', color: 'var(--text-main)' }}
                                    itemStyle={{ color: '#a855f7' }}
                                  />
                                  <Line type="monotone" dataKey="value" stroke="#a855f7" strokeWidth={2} dot={false} isAnimationActive={false} />
                                </LineChart>
                              </ResponsiveContainer>
                            )}
                          </div>
                        </div>
                      )}
                      </div>
                    </div>
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>
          )}
        </PanelGroup>
      </main>

      {/* Narrow-screen pane switcher — replaces the side-by-side split, which
          has no usable width on a phone. Hidden entirely on desktop. */}
      {isNarrow && (
        <nav data-tour="mobile-nav" className="app-bottom-nav shrink-0 flex border-t border-[var(--border-main)] bg-[var(--bg-panel)]">
          {([
            { id: "files" as const, label: "Workspace", icon: FolderOpen },
            ...(appMode === "agentic" ? [{ id: "agent" as const, label: "Agent", icon: Bot }] : []),
            { id: "editor" as const, label: "Code", icon: Code },
          ]).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setMobilePane(id)}
              aria-current={mobilePane === id}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[52px] text-[10px] font-medium transition ${
                mobilePane === id
                  ? "text-[var(--accent-primary)] bg-[var(--accent-primary-soft)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
      )}

      {/* The profile menu, opened from the account row at the top of the
          sidebar. Fixed to the page: a resizable panel would clip it. */}
      {isMenuOpen && profileMenuAt && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
          <div
            className="fixed w-56 bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-lg z-50 py-1 animate-slide-up"
            style={{ boxShadow: 'var(--shadow-panel)', left: Math.max(8, Math.min(profileMenuAt.left, window.innerWidth - 232)), top: profileMenuAt.top }}
          >
            {user && (
              <div className="px-3 py-2 mb-1 border-b border-[var(--border-main)]">
                <p className="text-xs font-medium text-[var(--text-main)] truncate">{user.displayName || user.email?.split("@")[0] || "Your account"}</p>
              </div>
            )}
            {usageInfo && (
              <div className="px-3 py-2 mb-1 border-b border-[var(--border-main)]">
                {usageInfo.tokenCap !== null && (
                  <>
                    <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] mb-1">
                      <Activity size={11} />
                      <span>This {WINDOW_HOURS}-hour window</span>
                      <span className="ml-auto text-[var(--text-main)] font-medium">{percentUsed(usageInfo.tokensUsed, usageInfo.tokenCap)}% used</span>
                    </div>
                    <div className="h-1 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.min(100, (usageInfo.tokensUsed / usageInfo.tokenCap) * 100)}%`, background: 'var(--gradient-hero)' }}
                      />
                    </div>
                    <p className="mt-1 text-[10px] text-[var(--text-subtle)]">
                      {usageInfo.windowResetAt ? `Refills ${formatWhen(usageInfo.windowResetAt)}` : "Your next message starts a window"}
                    </p>
                    {usageInfo.cycleCap !== null && usageInfo.cycleUsed !== null && (
                      <p className="mt-0.5 flex text-[10px] text-[var(--text-muted)]">
                        <span>This month</span>
                        <span className="ml-auto text-[var(--text-main)] font-medium">{percentUsed(usageInfo.cycleUsed, usageInfo.cycleCap)}% used</span>
                      </p>
                    )}
                  </>
                )}
                {usageInfo.subscriptionStatus === "active" ? (
                  <>
                    {usageInfo.renewsAt && (
                      <p className="mt-2 text-[10px] text-[var(--text-subtle)]">Renews {formatDay(usageInfo.renewsAt)}</p>
                    )}
                    <button
                      onClick={handleCancelSubscription}
                      disabled={isCancelingSubscription}
                      className="w-full flex items-center gap-1.5 mt-2 text-[10px] text-[var(--text-muted)] hover:text-red-400 transition disabled:opacity-50"
                    >
                      <X size={11} />
                      {isCancelingSubscription ? "Canceling…" : "Cancel Subscription"}
                    </button>
                  </>
                ) : usageInfo.subscriptionStatus === "past_due" && isPro ? (
                  // A renewal failed: PRO carries on for the grace period.
                  <>
                    <p className="mt-2 text-[10px] leading-snug text-red-400">
                      Your PRO payment didn't go through. PRO continues{usageInfo.proUntil ? ` until ${formatDay(usageInfo.proUntil)}` : " for a few days"}.
                    </p>
                    <button
                      onClick={() => { setIsMenuOpen(false); void handleSubscribe(); }}
                      disabled={isSubscribing}
                      className="w-full flex items-center gap-1.5 mt-2 text-[10px] font-medium gradient-text hover:opacity-80 transition disabled:opacity-50"
                    >
                      <Rocket size={12} className="text-orange-500" />
                      Pay now to keep PRO
                    </button>
                  </>
                ) : usageInfo.subscriptionStatus === "canceled" && isPro && usageInfo.proUntil ? (
                  <p className="mt-2 text-[10px] text-[var(--text-subtle)]">PRO until {formatDay(usageInfo.proUntil)} · won't renew</p>
                ) : !isPro && accountTier !== null ? (
                  // PRO accounts, paid or granted, are never offered an upgrade.
                  <button
                    onClick={() => { setIsMenuOpen(false); setIsPlansOpen(true); }}
                    className="w-full flex items-center gap-1.5 mt-2 text-[10px] font-medium gradient-text hover:opacity-80 transition"
                  >
                    <Rocket size={12} className="text-orange-500 rocket-blaze" />
                    Upgrade — $7/mo
                  </button>
                ) : null}
              </div>
            )}
            {canInstall && (
              <button
                onClick={() => { setIsMenuOpen(false); installApp(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition rounded-md mx-1"
              >
                <Download size={14} className="text-[var(--text-muted)]" />
                Install app
              </button>
            )}
            <button
              onClick={() => { setIsMenuOpen(false); setShowWelcome(false); setTourOpen(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition rounded-md mx-1"
            >
              <Compass size={14} className="text-[var(--text-muted)]" />
              Take the tour
            </button>
            <button
              onClick={() => { setIsMenuOpen(false); setFeedbackOpen(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition rounded-md mx-1 sm:hidden"
            >
              <MessageSquarePlus size={14} className="text-[var(--text-muted)]" />
              Send feedback
            </button>
            <button
              onClick={() => { setIsMenuOpen(false); signOut(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition rounded-md mx-1"
            >
              <LogOut size={13} className="text-red-400" />
              Sign Out
            </button>
          </div>
        </>
      )}

      {tourOpen && (
        <OnboardingTour
          steps={tourSteps}
          onClose={closeTour}
          finishAction={appMode === "agentic" ? {
            label: "Try it: blink an LED on pin 4",
            onClick: () => {
              if (isNarrowRef.current) setMobilePane("agent");
              handleSendMessage("Blink an LED connected to pin 4 of my board: on for half a second, off for half a second.");
            },
          } : undefined}
        />
      )}

      {isLibrariesOpen && <LibrariesModal onClose={() => setIsLibrariesOpen(false)} />}

      {projectLimitOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={() => setProjectLimitOpen(false)}>
          <div className="flex min-h-full items-end sm:items-center justify-center sm:p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-limit-title"
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-sm bg-[var(--bg-root)] border border-[var(--border-main)] sm:rounded-2xl rounded-t-2xl shadow-2xl px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] animate-slide-up"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 id="project-limit-title" className="font-display font-bold text-base text-[var(--text-main)] leading-snug">
                  All {FREE_PROJECT_LIMIT} free project slots are in use
                </h2>
                <button
                  onClick={() => setProjectLimitOpen(false)}
                  aria-label="Close"
                  className="w-9 h-9 -mr-2 -mt-1 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition shrink-0"
                >
                  <X size={17} />
                </button>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
                The Free plan holds {FREE_PROJECT_LIMIT} projects at a time. Delete one you no longer need to make room, or get PRO for unlimited projects.
              </p>
              <div className="mt-4 space-y-2">
                <button
                  onClick={() => { setProjectLimitOpen(false); setIsPlansOpen(true); }}
                  className="w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-[13px] font-bold text-white shadow-md"
                  style={{ background: "var(--gradient-hero)" }}
                >
                  <Rocket size={14} /> Get PRO — unlimited projects
                </button>
                <button
                  onClick={() => { setProjectLimitOpen(false); setShowProjectsBrowser(true); }}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-[var(--border-main)] py-2.5 text-[13px] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
                >
                  <FolderOpen size={14} /> Manage projects
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isPlansOpen && !isPro && (
        <PlansModal
          onClose={() => setIsPlansOpen(false)}
          onUpgrade={handleSubscribe}
          upgrading={isSubscribing}
        />
      )}

      {/* Web3 Wallet Modal */}
      {isWalletModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl w-full max-w-md shadow-2xl flex flex-col overflow-hidden max-h-[90vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)] bg-[var(--bg-root)] shrink-0">
              <h2 className="font-display font-bold text-sm text-[var(--text-main)] flex items-center gap-2">
                Web3 Oracle
                <span className="text-[9px] text-[var(--text-muted)] bg-[var(--bg-surface)] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold">Coming soon</span>
              </h2>
              <button onClick={() => setIsWalletModalOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <Web3Panel walletState={walletState} setWalletState={setWalletState} />
            </div>
          </div>
        </div>
      )}

      {/* Edge Impulse Modal */}
      {isEdgeImpulseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)] bg-[var(--bg-root)] shrink-0">
              <h2 className="font-display font-bold text-sm text-[var(--text-main)] flex items-center gap-2">
                <Cloud size={14} className="text-purple-400" /> Edge Impulse
              </h2>
              <button onClick={() => setIsEdgeImpulseModalOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
                <X size={18} />
              </button>
            </div>
            <div className="p-8 flex flex-col items-center text-center gap-3">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-lg animate-pulse"
                style={{ background: 'var(--gradient-hero)', boxShadow: 'var(--shadow-glow)' }}
              >
                <Cloud size={26} />
              </div>
              <h3 className="font-display font-bold text-lg gradient-text">Coming Soon</h3>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed max-w-xs">
                Edge Impulse integration for on-device machine learning is being polished and isn't available yet.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Pause screen — shown when the account's AI tokens are used for now.
          Counts down to the refill; Free accounts are shown the way up. */}
      {isUpgradeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="pause-title" className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)] bg-[var(--bg-root)] shrink-0">
              <h2 id="pause-title" className="font-display font-bold text-sm text-[var(--text-main)] flex items-center gap-2">
                <Lock size={14} className="text-orange-400" />
                {quotaBlockInfo?.reason === "cycle"
                  ? "This cycle's AI tokens are used"
                  : quotaBlockInfo?.tier === "free"
                    ? (quotaBlockInfo?.reason === "day" ? "Today's free AI tokens are used" : "Free AI tokens used for now")
                    : "This session's AI tokens are used"}
              </h2>
              <button onClick={() => setIsUpgradeModalOpen(false)} aria-label="Close" className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
                <X size={18} />
              </button>
            </div>
            <div className="p-8 flex flex-col items-center text-center gap-3">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-lg"
                style={{ background: 'var(--gradient-hero)', boxShadow: 'var(--shadow-glow)' }}
              >
                <Clock size={26} />
              </div>
              <h3 className="font-display font-bold text-lg gradient-text">
                {pauseWait ? `Back in ${pauseWait}` : "Back on your next billing date"}
              </h3>
              {quotaBlockInfo?.resetAt ? (
                <p className="-mt-2 text-[11px] text-[var(--text-subtle)]">{formatWhen(quotaBlockInfo.resetAt)}</p>
              ) : null}
              <p className="text-xs text-[var(--text-muted)] leading-relaxed max-w-xs">
                {quotaBlockInfo?.tier === "free"
                  ? <>PRO gives you {PRO_WINDOW_TOKENS / FREE_WINDOW_TOKENS}× more every {WINDOW_HOURS} hours, with auto-debug and Plan Mode.</>
                  : quotaBlockInfo?.reason === "cycle"
                    ? <>You've used this month's PRO allowance; it refreshes on your next billing date.</>
                    : <>This {WINDOW_HOURS}-hour window's allowance is used; the agent picks up again when it refills.</>}
              </p>
              {quotaBlockInfo?.tier === "free" && !isPro && (
                <button
                  onClick={() => { setIsUpgradeModalOpen(false); setIsPlansOpen(true); }}
                  className="w-full mt-2 py-2.5 rounded-lg text-white text-sm font-bold shadow-md flex items-center justify-center gap-2 transition"
                  style={{ background: 'var(--gradient-hero)' }}
                >
                  <Rocket size={15} /> Get PRO — 10× more
                </button>
              )}
              <button
                onClick={() => setIsUpgradeModalOpen(false)}
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--text-muted)] transition"
              >
                {quotaBlockInfo?.tier === "free" ? "Wait for the refill" : "OK"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showProjectsBrowser && (
        <ProjectsBrowser
          currentProjectId={currentProjectId}
          onClose={() => setShowProjectsBrowser(false)}
          onOpenProject={handleOpenProject}
          onNewProject={() => { setShowProjectsBrowser(false); void openNewProject(); }}
          projectLimit={accountTier === "free" ? FREE_PROJECT_LIMIT : undefined}
        />
      )}

      {/* The rail carries the trigger on wide layouts. On phones the rail is
          hidden and a floating button landed on top of the files control, so
          the trigger moves into the profile menu and only the panel renders. */}
      {user && isNarrow && (
        <FeedbackWidget
          variant="headless"
          boardId={boardId}
          mcu={mcu}
          open={feedbackOpen}
          onOpenChange={setFeedbackOpen}
        />
      )}

      {webPreviewOpen && (
        <WebPreviewPanel
          onClose={() => setWebPreviewOpen(false)}
          code={code}
          lines={terminalLines.map((l) => l.text)}
        />
      )}

      {githubOpen && user && (
        <GithubPanel
          onClose={() => setGithubOpen(false)}
          projectName={currentProjectName || "joint-agent-project"}
          code={code}
          description={description}
          boardLabel={boardNames.get(boardId) || (mcu || "").toUpperCase()}
          schematicJson={JSON.stringify({ components, connections }, null, 2)}
        />
      )}

      {showWelcome && user && (
        <WelcomeModal
          displayName={user.displayName?.split(" ")[0] || ""}
          projects={recentProjects}
          loading={loadingRecent}
          onNewProject={() => { setShowWelcome(false); void openNewProject(); }}
          onOpenProject={(id) => { setShowWelcome(false); handleOpenProject(id); }}
          onBrowseAll={() => { setShowWelcome(false); setShowProjectsBrowser(true); }}
          onClose={() => setShowWelcome(false)}
          boardNames={boardNames}
        />
      )}

      {showNewProjectModal && (
        <NewProjectModal
          onClose={() => { setShowNewProjectModal(false); setImportedFileCode(null); setImportedFileName(""); }}
          onCreate={(name, board) => handleCreateProject(name, board, importedFileCode || undefined)}
          initialName={importedFileName}
          mode={importedFileCode ? "import" : "create"}
          detectedBoardId={detectedBoardId}
          detectedFamily={detectedMcu}
          detectedName={detectedBoard}
        />
      )}

      {/* Retrieved Firmware Modal */}
      {retrievedFirmware && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--bg-panel)] rounded-lg shadow-xl border border-[var(--border-main)] p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-[var(--text-main)] mb-2">Firmware Retrieved</h3>
            <p className="text-[var(--text-muted)] text-sm mb-6">
              1MB of firmware was successfully read from the board. You can download the binary file or copy it as a Base64 string to your clipboard.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setRetrievedFirmware(null)}
                className="px-4 py-2 rounded text-sm text-[var(--text-muted)] hover:text-[var(--text-main)] transition"
              >
                Close
              </button>
              <button
                onClick={() => {
                  const blob = new Blob([retrievedFirmware as any]);
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = reader.result as string;
                    const b64 = dataUrl.split(',')[1];
                    navigator.clipboard.writeText(b64);
                    logToTerminal("[RETRIEVE] Copied firmware Base64 to clipboard.", "success");
                  }
                  reader.readAsDataURL(blob);
                }}
                className="px-4 py-2 rounded text-sm bg-[var(--bg-hover)] text-[var(--text-main)] hover:bg-[var(--border-main)] transition"
              >
                Copy Base64
              </button>
              <button
                onClick={() => {
                  const blob = new Blob([retrievedFirmware as any], { type: "application/octet-stream" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "firmware_backup.bin";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
                className="px-4 py-2 rounded text-sm bg-blue-600 text-white hover:bg-blue-500 transition"
              >
                Download .bin
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
