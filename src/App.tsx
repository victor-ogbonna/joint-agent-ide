import React, { useState, useEffect, useRef, useMemo } from "react";
import { Cpu, Terminal as TerminalIcon, Sun, Moon, Layers, Code, Zap, FileCode, FolderOpen, ChevronDown, ChevronRight, Wallet, Shield, Check, Info, Settings, Bot, PenTool, X, Palette, Usb, MoreVertical, Plus, Activity, Monitor, Copy, Cloud, LogOut, Lock, Sparkles, Upload, MessageSquarePlus} from "lucide-react";
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
import CodeEditor from "./components/CodeEditor";
import SchematicViewer from "./components/SchematicViewer";
import Terminal from "./components/Terminal";
import AgentChat from "./components/AgentChat";
import Web3Panel from "./components/Web3Panel";
import ProjectsBrowser from "./components/ProjectsBrowser";
import NewProjectModal from "./components/NewProjectModal";
import WelcomeModal from "./components/WelcomeModal";
import FeedbackWidget from "./components/FeedbackWidget";
import { ESPLoader, Transport } from "esptool-js";
import { flashAvr } from "./lib/avrFlash";
import { isWebUsbAvailable, requestUsbSerialPort, getGrantedUsbSerialPorts } from "./lib/webusbSerial";
import { createProject, getProject, updateProject, renameProject, listProjects, ProjectSummary, trimMessagesForStorage } from "./lib/projects";
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

// Mirrors server/quota.ts's FREE_TOKEN_CAP / PAID_TOKEN_CAP — used for display
// copy only, the real enforcement is server-side.
const FREE_TOKEN_CAP = 50000;
const PAID_TOKEN_CAP = 400000;

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
  const [selectedPane, setSelectedPane] = useState<MobilePane>("editor");
  const [appMode, setAppMode] = useState<AppMode>("agentic");
  const [theme, setTheme] = useState<AppTheme>("dark");
  const [activeTab, setActiveTab] = useState<EditorTab>("code");
  // The agent pane doesn't exist in manual mode — without this, switching
  // modes while it's selected would leave every pane hidden (blank screen).
  const mobilePane: MobilePane =
    selectedPane === "agent" && appMode !== "agentic" ? "editor" : selectedPane;
  const setMobilePane = setSelectedPane;
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [isEdgeImpulseModalOpen, setIsEdgeImpulseModalOpen] = useState(false);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [quotaBlockInfo, setQuotaBlockInfo] = useState<QuotaBlockedInfo | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [mcuPluggedIn, setMcuPluggedIn] = useState(false);
  const mcuPluggedInRef = useRef(false);

  useEffect(() => {
    mcuPluggedInRef.current = mcuPluggedIn;
  }, [mcuPluggedIn]);
  const [isTerminalOpen, setIsTerminalOpen] = useState(true);
  const [isSerialMonitorOpen, setIsSerialMonitorOpen] = useState(false);
  const [isSerialPlotterOpen, setIsSerialPlotterOpen] = useState(false);
  const [autoScrollSerial, setAutoScrollSerial] = useState(true);
  const serialMonitorRef = useRef<HTMLDivElement>(null);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [usageInfo, setUsageInfo] = useState<{ tokensUsed: number; tokenCap: number; subscriptionStatus: string } | null>(null);
  const [isCancelingSubscription, setIsCancelingSubscription] = useState(false);

  const [mcu, setMcu] = useState<MCUType>("esp32");
  const [boardId, setBoardId] = useState<string>("esp32dev");
  const [chatMode, setChatMode] = useState<"plan" | "implement">("plan"); // internal representation, hidden from user
  const [detectedBoard, setDetectedBoard] = useState<string | null>(null);
  // The catalogue board id behind detectedBoard, when USB identified one exactly.
  const [detectedBoardId, setDetectedBoardId] = useState<string | null>(null);
  // What the USB id reports, as opposed to what the project targets. null when
  // the adapter can't identify the chip (CH340 clones and the like), which is
  // not a mismatch — it is simply unknown, so it must not block a flash.
  const [detectedMcu, setDetectedMcu] = useState<MCUType | null>(null);

  const bootLoggedRef = useRef(false);
  const autoConnectedLogRef = useRef(false);

  const [code, setCode] = useState(INITIAL_CODE);
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
  const [feedbackOpen, setFeedbackOpen] = useState(false);
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
        if (status.blocked) {
          const info: QuotaBlockedInfo = { tier: status.subscriptionStatus === "active" ? "paid" : "free", tokensUsed: status.tokensUsed, tokenCap: status.tokenCap };
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
        setUsageInfo({ tokensUsed: status.tokensUsed, tokenCap: status.tokenCap, subscriptionStatus: status.subscriptionStatus });
      } catch {
        // Non-fatal — the dropdown just won't show a usage figure this time.
      }
    })();
  };

  const handleCancelSubscription = async () => {
    if (!user) return;
    if (!window.confirm("Cancel your $7/month subscription? You'll keep access until the current cycle ends, then the free token cap applies again.")) return;
    setIsCancelingSubscription(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/paystack/cancel", { method: "POST", headers: { Authorization: `Bearer ${idToken}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not cancel subscription.");
      setUsageInfo((prev) => (prev ? { ...prev, subscriptionStatus: "canceled" } : prev));
      logToTerminal("[BILLING] Subscription canceled.", "info");
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
      logToTerminal("  Joint-Agent Embedded Core Ready                          ", "info");
      logToTerminal("==========================================================", "info");
      logToTerminal(`System Core: Node compiler initialized. Powered by Joint-Agent Engine.`, "info");
      bootLoggedRef.current = true;
    }

    const handleConnect = (e: any) => {
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
          setDetectedBoard(`Connected: ${boardName}${vendorId ? ` (VID: 0x${vendorId.toString(16).toUpperCase()})` : ""}`);
          setDetectedBoardId(board?.boardId ?? null);
        }
      }
    };

    const handleDisconnect = (e: any) => {
      if (mcuPluggedInRef.current) {
        logToTerminal("[USB] Device disconnected.", "error");
        autoConnectedLogRef.current = false;
        setMcuPluggedIn(false);
        setDetectedBoard(null);
        setDetectedBoardId(null);
        setDetectedMcu(null);
      }
    };

    if ("serial" in navigator) {
      (navigator as any).serial.addEventListener("connect", handleConnect);
      (navigator as any).serial.addEventListener("disconnect", handleDisconnect);

      // Check already paired devices

    }

    return () => {
      if ("serial" in navigator) {
        (navigator as any).serial.removeEventListener("connect", handleConnect);
        (navigator as any).serial.removeEventListener("disconnect", handleDisconnect);
      }
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

  /** Ask the user to authorise a board, on whichever transport exists. */
  const requestBoardPort = async (): Promise<any> =>
    hasWebSerial ? await (navigator as any).serial.requestPort() : await requestUsbSerialPort();

  /** Boards already authorised in a previous session. */
  const grantedBoardPorts = async (): Promise<any[]> =>
    hasWebSerial ? await (navigator as any).serial.getPorts() : await getGrantedUsbSerialPorts();

  const handleAutoDetect = async () => {
    logToTerminal("[USB] Scanning for connected microcontrollers...", "info");

    if (canReachBoard) {
      try {
        logToTerminal(
          hasWebSerial
            ? "[USB] Web Serial supported. Prompting for port..."
            : "[USB] Using WebUSB. Prompting for device...",
          "info"
        );
        const port = await requestBoardPort();
        webSerialPortRef.current = port;
        await port.open({ baudRate: 115200 });
        const info = await port.getInfo();
        await port.close();

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
            `[USB] This adapter can't identify the chip behind it, so builds will target this project's board (${mcu.toUpperCase()}).`,
            "info"
          );
        }
      } catch (err: any) {
        if (err.name === 'NotFoundError' || err.message?.includes("No port selected") || err.message?.includes("User rejected")) {
          logToTerminal("[USB] Port selection cancelled by user.", "info");
          return;
        }
        logToTerminal(`[USB] Web Serial error: ${err.message}. Trying backend detection...`, "info");
        await handleBackendDetect();
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
            logToTerminal(`[SERIAL] ${msg.data}`, "serial");
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
  const handleExecuteCommand = (cmd: string) => {
    logToTerminal(cmd, "input");
    const cmdClean = cmd.toLowerCase().trim();

    if (cmdClean === "help") {
      logToTerminal("Joint-Agent Terminal - Available commands:", "info");
      logToTerminal("  help                      List available shell commands", "success");
      logToTerminal("  compile                   Verify & compile the current C++ code", "success");
      logToTerminal("  flash                     Upload the binary code to target board", "success");
      logToTerminal("  clear                     Clear the terminal screen output", "success");
      logToTerminal("  pio system                View Joint-Agent Engine compiler metadata", "success");
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
    } else if (cmdClean === "pio system" || cmdClean === "platformio --version" || cmdClean === "pio --version") {
      logToTerminal("Joint-Agent Engine System Information:", "info");
      logToTerminal("  Engine:        Joint-Agent Engine (embedded build core)", "info");
      logToTerminal(`  Host OS:       Linux (Cloud Sandbox)`, "info");
      logToTerminal(`  Framework:     Arduino compiler suite`, "info");
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
  const handleCompile = async (overrideCode?: string): Promise<{ success: boolean, data?: any, errorText?: string, compileSucceeded?: boolean }> => {
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

      if (data.success) {
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
        setIsCompiling(false);
        return { success: false, errorText, compileSucceeded: data.compileSucceeded === true };
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
    if (serialReaderRef.current) {
      try {
        await serialReaderRef.current.cancel();
      } catch (e) { }
      serialReaderRef.current = null;
    }
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
    if (!detectedBoard || !mcuPluggedIn) {
      logToTerminal("[FLASH] ERROR: No board detected. Click 'Auto-Detect Board' first.", "error");
      return { success: false, error: "No board detected." };
    }

    // Release any active serial monitor locks before we do anything
    if (serialReaderRef.current) {
      try { await serialReaderRef.current.cancel(); } catch (e) { }
      serialReaderRef.current = null;
    }
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
    logToTerminal(`[FLASH] Initiating flash to ${detectedBoard}...`, "info");

    const codeToFlash = overrideCode || code;

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
        return { success: true };
      } catch (err: any) {
        logToTerminal(`[FLASH] ${err.message}`, "error");
        setIsFlashing(false);
        return { success: false, error: err.message };
      } finally {
        // Without this a failed attempt leaves the port claimed, and every
        // later flash in the same session fails for a different reason.
        if (avrPort) { try { await avrPort.close(); } catch { /* already closed */ } }
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
        transport = new Transport(port, true);
        const term = {
          clean: () => { },
          writeLine: (data: string) => logToTerminal(`[FLASH] ${data}`, "info"),
          write: (data: string) => logToTerminal(`[FLASH] ${data}`, "info"),
        };
        const loader = new ESPLoader({ transport, baudrate: 115200, terminal: term });
        await loader.main();

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

        await loader.writeFlash({
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

        await loader.after();
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
        logToTerminal(`[FLASH] Web Serial flash failed: ${err.message}. Falling back to backend PlatformIO...`, "info");
        return await handleBackendFlash(codeToFlash);
      }
    }
  };

  // Web Serial monitor for Chrome (after esptool-js flash)
  const startWebSerialMonitor = async (port: any) => {
    logToTerminal("[SERIAL MONITOR INITIALIZED @ 115200 BAUD]", "serial");
    try {
      if (port.readable === null) {
        await port.open({ baudRate: 115200 });
      }
      activePortRef.current = port;

      if (mcu === "esp32") {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      }

      const reader = port.readable.getReader();
      serialReaderRef.current = reader;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) { reader.releaseLock(); serialReaderRef.current = null; break; }
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.trim()) {
          logToTerminal(`[SERIAL] ${chunk.trim()}`, "serial");
        }
      }
    } catch (e: any) {
      logToTerminal(`[SERIAL ERROR] ${e.message}`, "error");
      serialReaderRef.current = null;
    }
  };

  // Backend PlatformIO flash — works in ALL browsers, supports ALL MCUs
  const handleBackendFlash = async (codeToFlash: string): Promise<{ success: boolean, error?: string }> => {
    logToTerminal(`[FLASH] Using PlatformIO CLI to compile and upload (${mcu.toUpperCase()})...`, "info");
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
        logToTerminal(`[FLASH] SUCCESS: ${mcu.toUpperCase()} flashed via PlatformIO!`, "success");
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
        logToTerminal("[DEBUGGER] Free AI tokens used up — upgrade to keep instrumenting code.", "error");
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

  const handleDebugCode = async (actualError?: string, overrideCode?: string): Promise<{ success: boolean, code?: string, blocked?: boolean }> => {
    const requestProjectId = currentProjectIdRef.current;
    let resultCode = overrideCode || code;
    let resultSuccess = false;
    let resultBlocked = false;
    setIsDebugging(true);
    logToTerminal("[AI AGENT] Analysing code structure and syntax rules...", "info");

    try {
      const result = await callAiEndpoint("/api/ai/debug", {
        code: overrideCode || code,
        error: actualError || "Compilation check request. Scan for syntax risks and optimize memory allocation.",
        mcu,
        boardId
      });

      if (!result.ok) {
        if (result.blocked) {
          resultBlocked = true;
          setQuotaBlockInfo(result.info);
          setIsUpgradeModalOpen(true);
          logToTerminal("[AI AGENT] Free AI tokens used up — upgrade to keep auto-debugging.", "error");
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
    return { success: resultSuccess, code: resultBlocked ? undefined : resultCode, blocked: resultBlocked };
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

    const MAX_ATTEMPTS = 5;
    let attempt = 0;
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

    while (!compileResult.success && attempt < MAX_ATTEMPTS) {
      attempt++;
      logToTerminal(`[SMART FLASH] Compile error detected. AI auto-debug attempt ${attempt}/${MAX_ATTEMPTS}...`, "error");
      const debugResult = await handleDebugCode(compileResult.errorText, currentCode);
      if (!debugResult.code) {
        if (debugResult.blocked) {
          logToTerminal("[SMART FLASH] Stopped — free AI tokens used up. Upgrade to keep auto-debugging.", "error");
        } else {
          logToTerminal("[SMART FLASH] AI debugger returned no fix. Aborting.", "error");
        }
        setIsSmartFlashing(false);
        return;
      }
      currentCode = debugResult.code;
      compileResult = await handleCompile(currentCode);
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

    setIsSmartFlashing(false);
  };

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
      logToTerminal("[AI AGENT] Request aborted by user.", "error");
    }
  };

  const handleSendMessage = async (text: string, modeOverride?: "plan" | "implement") => {
    const requestProjectId = currentProjectIdRef.current;
    const newUserMsg: ChatMessage = {
      id: Math.random().toString(),
      role: "user",
      content: text,
      timestamp: Date.now()
    };

    const newMessages = [...chatMessages, newUserMsg];
    setChatMessages(newMessages);
    setIsLoading(true);

    abortControllerRef.current = new AbortController();

    logToTerminal(`[AI AGENT] Processing request: "${text.slice(0, 30)}..."`, "info");

    const effectiveMode = modeOverride || chatMode;

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
        { messages: newMessages, mcu, boardId, chatMode: effectiveMode },
        (event) => {
          if (event.type === "text_delta") {
            assistantContent += event.text;
            ensureStarted();
            updateAssistantMsg({ content: assistantContent });
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
              : `Running \`${event.command}\` in the terminal.`;
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
        handleExecuteCommand(pendingCommand);
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

  const DEFAULT_DESCRIPTION = "A standard flashing LED circuit safely wired through a 220 Ohm current-limiting resistor. Ideal for validating MCU state loops.";

  const handleCreateProject = async (name: string, board: BoardInfo, codeOverride?: string) => {
    if (!user) return;
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
      setShowNewProjectModal(true);
    };
    reader.onerror = () => {
      logToTerminal("[PROJECT] Could not read the selected .ino file.", "error");
    };
    reader.readAsText(file);
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

  return (
    <div className="app-shell h-full bg-[var(--bg-root)] text-[var(--text-main)] flex flex-col antialiased overflow-hidden">
      {/* Universal Header — Glassmorphism */}
      <header className="h-12 border-b border-[var(--border-main)] header-glass px-2 sm:px-4 flex items-center justify-between shrink-0 z-30">
        <div className="flex items-center gap-1.5 sm:gap-3">
          {/* Logo */}
          <div className="flex items-center gap-2.5 logo-accent cursor-default select-none">
            <img src="/logo.png" alt="Joint-Agent IDE" className="w-7 h-7 rounded-lg shrink-0 shadow-md" />
            <div className="flex flex-col hidden sm:flex">
              <h1 className="font-display font-bold text-[13px] text-[var(--text-main)] tracking-wide leading-tight flex items-center gap-1.5">
                Joint-Agent <span className="gradient-text">IDE</span>
                <span className="text-[8px] font-mono font-semibold text-[var(--text-subtle)] bg-[var(--bg-surface)] border border-[var(--border-main)] rounded px-1 py-px leading-none">
                  v1.0
                </span>
              </h1>
              <p className="text-[8px] text-[var(--text-subtle)] font-mono tracking-[0.2em] uppercase">IoT · Blockchain · AI</p>
            </div>
          </div>

          <div className="h-5 w-px bg-[var(--border-main)] mx-1 hidden sm:block"></div>

          {/* Mode Switcher — Pill Style */}
          <div className="flex bg-[var(--bg-root)] p-[3px] rounded-lg border border-[var(--border-main)] shrink-0">
            <button
              onClick={() => setAppMode("agentic")}
              className={`flex items-center gap-1.5 px-3 py-1.5 sm:py-1 min-h-[34px] sm:min-h-0 rounded-md text-[10px] font-semibold tracking-wide uppercase transition-all duration-200 ${appMode === "agentic" ? "bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] shadow-sm" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                }`}
            >
              <Bot size={11} className={appMode === "agentic" ? "text-[var(--accent-primary)]" : ""} />
              <span className="hidden sm:inline">Agent</span>
            </button>
            <button
              onClick={() => setAppMode("manual")}
              className={`flex items-center gap-1.5 px-3 py-1.5 sm:py-1 min-h-[34px] sm:min-h-0 rounded-md text-[10px] font-semibold tracking-wide uppercase transition-all duration-200 ${appMode === "manual" ? "bg-[var(--accent-secondary-soft)] text-[var(--accent-secondary)] shadow-sm" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
                }`}
            >
              <PenTool size={11} className={appMode === "manual" ? "text-[var(--accent-secondary)]" : ""} />
              <span className="hidden sm:inline">Manual</span>
            </button>
          </div>
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
                className="bg-transparent border-none outline-none text-[11px] font-medium text-[var(--text-main)] w-full max-w-24 sm:max-w-36 min-w-0 py-1.5 sm:py-0"
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

          {(detectedBoard && mcuPluggedIn) ? (
            <div className="flex items-center gap-2 bg-green-500/5 px-2.5 py-1 rounded-lg border border-green-500/20 min-w-0 animate-slide-up">
              <div className="relative w-1.5 h-1.5 rounded-full bg-green-500 status-online"></div>
              <span className="text-[10px] font-mono text-green-400 flex items-center gap-1 tracking-wide min-w-0">
                <Usb size={10} className="shrink-0" />
                <span className="truncate">{detectedBoard}</span>
              </span>
              <button
                onClick={() => {
                  setDetectedBoard(null);
                  setDetectedBoardId(null);
                  setDetectedMcu(null);
                  setMcuPluggedIn(false);
                  webSerialPortRef.current = null;
                  logToTerminal("[USB] Connection disconnected/forgotten. You can scan again.", "info");
                }}
                className="p-0.5 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400 transition"
                title="Disconnect Board"
              >
                <X size={10} />
              </button>
            </div>
          ) : (
            <button
              onClick={handleAutoDetect}
              className="btn-lift flex items-center gap-1.5 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] px-2.5 py-1.5 sm:py-1 min-h-[34px] sm:min-h-0 rounded-lg border border-[var(--border-main)] text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] transition shrink-0"
            >
              <Cpu size={12} className="text-[var(--accent-secondary)]" />
              <span className="hidden sm:inline">Detect Board</span>
            </button>
          )}

          </div>

          {/* 3-Dot Menu — deliberately a sibling of the scroll container above,
              not a child of it. overflow-x-auto makes the browser compute
              overflow-y as auto too, which clips this dropdown (it hangs below
              the 48px header) to invisibility — the menu opens but nothing is
              visible. Keeping it outside lets it overlay freely. */}
          <div className="relative shrink-0">
            <button
              onClick={handleOpenProfileMenu}
              className="toolbar-btn p-2.5 sm:p-1.5 rounded-lg text-[var(--text-muted)] flex items-center gap-1.5"
              title={user?.email || undefined}
            >
              {user?.photoURL ? (
                <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-5 h-5 rounded-full" />
              ) : (
                <span
                  className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0"
                  style={{ background: 'var(--gradient-hero)' }}
                >
                  {(user?.displayName || user?.email || '?').charAt(0).toUpperCase()}
                </span>
              )}
              <MoreVertical size={14} />
            </button>
            {isMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-52 bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-lg z-50 py-1 animate-slide-up" style={{ boxShadow: 'var(--shadow-panel)' }}>
                  {user && (
                    <div className="px-3 py-2 mb-1 border-b border-[var(--border-main)]">
                      <p className="text-xs font-medium text-[var(--text-main)] truncate">{user.displayName || "Signed in"}</p>
                      <p className="text-[10px] text-[var(--text-muted)] truncate">{user.email}</p>
                    </div>
                  )}
                  {usageInfo && (
                    <div className="px-3 py-2 mb-1 border-b border-[var(--border-main)]">
                      <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] mb-1">
                        <Activity size={11} />
                        <span>{usageInfo.subscriptionStatus === "active" ? "This cycle" : "Free tokens"}</span>
                        <span className="ml-auto text-[var(--text-main)] font-medium">{usageInfo.tokensUsed.toLocaleString()} / {usageInfo.tokenCap.toLocaleString()}</span>
                      </div>
                      <div className="h-1 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.min(100, (usageInfo.tokensUsed / usageInfo.tokenCap) * 100)}%`, background: 'var(--gradient-hero)' }}
                        />
                      </div>
                      {usageInfo.subscriptionStatus === "active" ? (
                        <button
                          onClick={handleCancelSubscription}
                          disabled={isCancelingSubscription}
                          className="w-full flex items-center gap-1.5 mt-2 text-[10px] text-[var(--text-muted)] hover:text-red-400 transition disabled:opacity-50"
                        >
                          <X size={11} />
                          {isCancelingSubscription ? "Canceling…" : "Cancel Subscription"}
                        </button>
                      ) : (
                        <button
                          onClick={() => { setIsMenuOpen(false); setIsUpgradeModalOpen(true); }}
                          className="w-full flex items-center gap-1.5 mt-2 text-[10px] font-medium gradient-text hover:opacity-80 transition"
                        >
                          <Sparkles size={11} className="text-orange-500" />
                          Upgrade — $7/mo
                        </button>
                      )}
                    </div>
                  )}
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
          </div>
        </div>
      </header>

      {/* Main Workspace Layout with Resizable Panels */}
      <main className="flex-1 flex overflow-hidden">
        <PanelGroup orientation="horizontal">

          {/* Left Sidebar: File Explorer */}
          {(!isNarrow || mobilePane === "files") && (
          <Panel defaultSize={15} minSize={1}>
            <aside className="w-full h-full bg-[var(--bg-panel)] border-r border-[var(--border-main)] flex flex-col shrink-0">
              <div className="px-3 py-2.5 text-[9px] uppercase text-[var(--text-subtle)] font-bold tracking-[0.2em] border-b border-[var(--border-main)]">
                Projects
              </div>
              <div className="flex-1 overflow-y-auto py-1.5 space-y-0.5 terminal-scrollbar">
                <button
                  onClick={() => setShowNewProjectModal(true)}
                  className="w-[calc(100%-0.75rem)] text-left mx-1.5 px-2 py-1.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] cursor-pointer transition rounded-md"
                >
                  <Plus size={13} className="text-[var(--accent-primary)]" />
                  <span>New project</span>
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
                <input
                  ref={importFileInputRef}
                  type="file"
                  accept=".ino"
                  onChange={handleImportFileSelected}
                  className="hidden"
                />

                {/* Recent work. Sits directly under the project actions so a
                    returning user can reopen something without going through a
                    modal — the sidebar was otherwise empty space. */}
                <div className="pt-3 mt-2 border-t border-[var(--border-main)]">
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
                      <button
                        key={p.id}
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
                          <span className="text-[8px] uppercase tracking-wider text-[var(--accent-primary)] shrink-0">
                            open
                          </span>
                        )}
                      </button>
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

              <div className="border-t border-[var(--border-main)] p-2 space-y-1.5 shrink-0">
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

              <div className="border-t border-[var(--border-main)] p-1.5 space-y-0.5 mt-auto shrink-0">
                <button onClick={() => { setIsTerminalOpen(!isTerminalOpen); if (isNarrow) setMobilePane("editor"); }} className={`w-full flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-md transition ${isTerminalOpen ? 'bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] font-medium' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'}`}>
                  <TerminalIcon size={13} /> Terminal
                </button>
                <button onClick={() => { setIsSerialMonitorOpen(!isSerialMonitorOpen); if (isNarrow) setMobilePane("editor"); }} className={`w-full flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-md transition ${isSerialMonitorOpen ? 'bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] font-medium' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'}`}>
                  <Monitor size={13} /> Serial Monitor
                </button>
                <button onClick={() => { setIsSerialPlotterOpen(!isSerialPlotterOpen); if (isNarrow) setMobilePane("editor"); }} className={`w-full flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-md transition ${isSerialPlotterOpen ? 'bg-[var(--accent-primary-soft)] text-[var(--accent-primary)] font-medium' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'}`}>
                  <Activity size={13} /> Serial Plotter
                </button>
                <FeedbackWidget variant="sidebar" boardId={boardId} mcu={mcu} />
              </div>
            </aside>
          </Panel>
          )}

          {!isNarrow && <PanelResizeHandle className="panel-separator w-[3px] bg-[var(--border-main)] hover:bg-[var(--accent-primary)] transition-all duration-200 cursor-col-resize z-10" />}

          {/* Center: Agent Chat (Only in Agentic Mode) */}
          {appMode === "agentic" && (!isNarrow || mobilePane === "agent") && (
            <>
              <Panel defaultSize={55} minSize={1}>
                <div className="w-full h-full bg-[var(--bg-panel)] flex flex-col min-w-0">
                  <div className="flex bg-[var(--bg-panel)] border-b border-[var(--border-main)] shrink-0">
                    <div className="flex-1 py-2 text-xs font-medium border-t-2 border-orange-500 text-[var(--text-main)] bg-[var(--bg-root)] text-center">AI Agent</div>
                  </div>
                  <div className="flex-1 relative overflow-hidden">
                    <div className="absolute inset-0 z-10">
                      <AgentChat
                        messages={chatMessages}
                        onSendMessage={handleSendMessage}
                        isLoading={isLoading}
                        mcu={mcu}
                        onApplyUpdate={handleApplyProjectUpdate}
                        chatMode={chatMode}
                        setChatMode={setChatMode}
                        mcuPluggedIn={mcuPluggedIn}
                        onStopGeneration={handleStopGeneration}
                        isSmartFlashing={isSmartFlashing}
                        onSmartFlash={() => handleSmartFlash()}
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
          <Panel defaultSize={appMode === "agentic" ? 30 : 85} minSize={1}>
            <PanelGroup orientation="vertical">
              <Panel defaultSize={isTerminalOpen || isSerialMonitorOpen || isSerialPlotterOpen ? 70 : 100} minSize={1}>
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
                  <Panel defaultSize={30} minSize={1}>
                    <div className="w-full h-full bg-[var(--bg-panel)] flex min-h-0 min-w-0">
                      {isTerminalOpen && (
                        <div className="flex-1 min-w-0 h-full border-r border-[var(--border-main)] last:border-r-0">
                          <Terminal
                            lines={terminalLines}
                            onExecuteCommand={handleExecuteCommand}
                            onClear={() => setTerminalLines([])}
                            onClose={() => setIsTerminalOpen(false)}
                          />
                        </div>
                      )}

                      {isSerialMonitorOpen && (
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
                                onClick={() => setAutoScrollSerial(!autoScrollSerial)}
                                className={`flex items-center gap-1 text-[10px] transition px-1.5 py-0.5 rounded ${autoScrollSerial ? 'text-green-500 bg-green-500/10' : 'text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]'}`}
                                title={autoScrollSerial ? "Auto-Scroll: ON" : "Auto-Scroll: OFF"}
                              >
                                Auto-scroll
                              </button>
                              <button
                                onClick={() => {
                                  const text = terminalLines.filter(l => l.type === "serial").map(l => l.text).join('\n');
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
                              <button onClick={() => setIsSerialMonitorOpen(false)} className="text-[var(--text-muted)] hover:text-red-500 transition px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]">
                                <X size={12} />
                              </button>
                            </div>
                          </div>
                          <div ref={serialMonitorRef} className="flex-1 p-4 overflow-y-auto space-y-1.5 leading-normal terminal-scrollbar select-text bg-[var(--bg-root)] text-[var(--term-serial)]">
                            {terminalLines.filter(line => line.type === "serial").map((line) => (
                              <div key={line.id} className="flex items-start gap-1.5">
                                <span className="text-[10px] text-[var(--text-muted)] select-none font-mono mt-0.5 shrink-0">{line.timestamp}</span>
                                <pre className="whitespace-pre-wrap font-mono flex-1">{line.text}</pre>
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

                      {isSerialPlotterOpen && (
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
        <nav className="app-bottom-nav shrink-0 flex border-t border-[var(--border-main)] bg-[var(--bg-panel)]">
          {([
            { id: "files" as const, label: "Files", icon: FolderOpen },
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

      {/* Upgrade Modal — shown when the free AI token cap is hit */}
      {isUpgradeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-main)] bg-[var(--bg-root)] shrink-0">
              <h2 className="font-display font-bold text-sm text-[var(--text-main)] flex items-center gap-2">
                <Lock size={14} className="text-orange-400" /> Free AI Tokens Used Up
              </h2>
              <button onClick={() => setIsUpgradeModalOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
                <X size={18} />
              </button>
            </div>
            <div className="p-8 flex flex-col items-center text-center gap-3">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-lg"
                style={{ background: 'var(--gradient-hero)', boxShadow: 'var(--shadow-glow)' }}
              >
                <Sparkles size={26} />
              </div>
              <h3 className="font-display font-bold text-lg gradient-text">Upgrade to keep building</h3>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed max-w-xs">
                {quotaBlockInfo?.tier === "paid"
                  ? <>Subscribers get {PAID_TOKEN_CAP.toLocaleString()} AI tokens every billing cycle. You've used this cycle's allowance — it refreshes on your next billing date.</>
                  : <>Every account gets {FREE_TOKEN_CAP.toLocaleString()} free AI tokens to build with. You've used them all. Subscribe for $7/month for a {PAID_TOKEN_CAP.toLocaleString()}-token allowance every cycle.</>
                }
              </p>
              {quotaBlockInfo?.tier !== "paid" && (
                <button
                  onClick={handleSubscribe}
                  disabled={isSubscribing}
                  className="w-full mt-2 py-2.5 rounded-lg text-white text-sm font-semibold shadow-md disabled:opacity-60 disabled:cursor-not-allowed transition"
                  style={{ background: 'var(--gradient-hero)' }}
                >
                  {isSubscribing ? "Opening checkout…" : "Subscribe — $7/mo"}
                </button>
              )}
              <button
                onClick={() => setIsUpgradeModalOpen(false)}
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--text-muted)] transition"
              >
                Maybe later
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
          onNewProject={() => { setShowProjectsBrowser(false); setShowNewProjectModal(true); }}
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

      {showWelcome && user && (
        <WelcomeModal
          displayName={user.displayName?.split(" ")[0] || ""}
          projects={recentProjects}
          loading={loadingRecent}
          onNewProject={() => { setShowWelcome(false); setShowNewProjectModal(true); }}
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
