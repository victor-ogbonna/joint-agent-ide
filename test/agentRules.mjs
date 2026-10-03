/**
 * The rules the agent follows: the phone-app rule for every board, and the
 * Wi-Fi setup rule only where there is Wi-Fi (ESP32).
 */
import { PHONE_APP_RULE, WIFI_SETUP_RULE, boardRules } from "../server/agentRules.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

console.log("Which boards get which rules");
check(boardRules("esp32").includes(WIFI_SETUP_RULE) && boardRules("esp32").includes(PHONE_APP_RULE), "ESP32: Wi-Fi setup and the phone-app rule");
check(!boardRules("arduino").includes("WI-FI SETUP") && boardRules("arduino").includes(PHONE_APP_RULE), "Uno and Mega: no Wi-Fi rule, which they have no use for");

console.log("What the Wi-Fi setup rule asks for");
const has = (text, label) => check(WIFI_SETUP_RULE.includes(text), label, text);
has("WiFi.softAP", "the board makes its own network by default");
has("http://192.168.4.1", "and serves its page at the standard address");
has("at least 8 characters", "a password long enough for the board to accept");
has("DNSServer", "the setup page opens by itself when a phone joins");
has("network name, its password, the address", "the user is always told how to join");
has("stay connected", "and to stay on a network with no internet");
has("Safari or Chrome", "home-screen apps come from the browser, not the sign-in window");
has("Date.now()", "the phone's time goes with the page's requests when needed");
has("settimeofday", "and sets the board's clock");
has("Never show a time the board can't know", "no made-up times");
has("Preferences", "a home network typed in once is kept");
has("WiFiManager", "or the library that makes that page");
has("Never invent their Wi-Fi password", "no made-up passwords");
has("mDNS", "an easy name for the board on a home network");
has("WIFI_AP_STA", "both networks at once, when it fits");
has("ESP-NOW", "board to board with no router, when it fits");

if (bad) {
  console.log(`\n${bad} check(s) failed`);
  process.exit(1);
}
console.log("\nAll agent rule checks passed");
