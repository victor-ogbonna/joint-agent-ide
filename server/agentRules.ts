import type { BoardFamily } from "./boards";

/**
 * Rules the agent follows in every reply, kept here so they can be tested
 * (server.ts can't be imported without starting the server).
 */

/**
 * A sketch made a phone app with "Build App (PWA)" (src/lib/buildApp.ts)
 * has three things the agent must carry over whenever it rewrites the code.
 */
export const PHONE_APP_RULE = `PHONE APP: a sketch that includes <JointAgentApp.h> or <JointAgentAppAsync.h> was made a phone app with the "Build App (PWA)" button. Whenever you rewrite such a sketch, keep that #include, the JointAgentApp::serve(...) line in setup() and the tags between the two "Joint-Agent app" HTML comments in the page (and any <head> around them) exactly as they are. Never add them to a sketch yourself: when someone asks for a phone app, tell them to use "Build App (PWA)" under Web Preview in the sidebar.`;

/**
 * Getting an ESP32 onto Wi-Fi is where most people get stuck: a home
 * network's name and password typed into code, an address they can't find,
 * a phone that drops a network with no internet. So by default the board
 * makes its own network with a setup page that opens by itself, the way new
 * devices are set up, and the agent always says how to join it.
 */
export const WIFI_SETUP_RULE = `WI-FI SETUP (ESP32 projects that use Wi-Fi), so people get connected the first time without trouble:
- Unless the user asks for something else, the board makes its own Wi-Fi network (WiFi.softAP) and serves its page at http://192.168.4.1. Name the network after the project (e.g. "PlantMonitor-Setup") and give it a password of at least 8 characters (shorter ones make WiFi.softAP fail). Run a DNSServer on port 53 that answers every name with the board's address, and send any unknown page to "/" (onNotFound), so the page opens by itself when a phone joins, like the setup screen of a new device.
- Always tell the user, as a bullet list in the reply and in the description: the network name, its password, the address http://192.168.4.1, and that the phone may say the network has no internet, so they should choose to stay connected (on iPhone, "Use without internet").
- Home-screen apps (Build App): the page must be open in Safari or Chrome to be added to the home screen, not in the sign-in window that pops up on joining. Say so when the project is an app.
- If the project needs the real time (logs, schedules, timestamps) and the board has no internet, a short script on the page sends the phone's time with each form or request (Date.now() and new Date().getTimezoneOffset()); the board sets its clock from it (settimeofday from <sys/time.h>) and keeps counting from there. Never show a time the board can't know.
- When the board should join the home router instead (WiFi.begin), offer the simplest of: the user types their Wi-Fi name and password once into the board's own setup page (kept with Preferences, then the board restarts and joins), or the WiFiManager library, which makes that setup page for them. Never invent their Wi-Fi password: use clearly marked placeholders. Print the board's address on the serial monitor, start mDNS (ESPmDNS, e.g. http://plantmonitor.local, where the phone supports it; the number address always works), and remind them the phone must be on the same Wi-Fi.
- Mention other ways only when they fit better: both at once (WIFI_AP_STA: its own network for setup and the home network for the internet), or ESP-NOW for boards talking to each other without a router.`;

/** The rules for one board: the Wi-Fi setup rule only for boards with Wi-Fi. */
export function boardRules(family: BoardFamily): string {
  return family === "esp32" ? `${PHONE_APP_RULE}\n\n${WIFI_SETUP_RULE}` : PHONE_APP_RULE;
}
