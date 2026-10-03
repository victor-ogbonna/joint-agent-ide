/**
 * "Build App (PWA)": what a sketch can become, the changes that make a
 * board's own page a phone app, and the helper those changes rely on.
 */
import fs from "fs";
import path from "path";
import { inspectProject, applyApp, removeApp, appliedSettings, cleanAppName, shortNameFrom, appHeadTags } from "../src/lib/buildApp.ts";
import { appHelperFiles, usesAppHelper } from "../src/lib/appHeaders.ts";
import { APP_ICON_PNG_BASE64 } from "../server/appIcon.ts";
import { addAppHelper } from "../server/appSupport.ts";
import { extractHtml, fillRuntimePlaceholders } from "../src/components/WebPreviewPanel.tsx";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
// Transformed sketches are written here when set, for real compiles.
const OUT = process.env.BUILD_APP_SKETCHES;
const keep = (name, code) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), code); } };

const settings = { name: "Plant Monitor", shortName: "Plant", themeColor: "#0F766E", display: "standalone" };

const WEB = `#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

// The board makes its own Wi-Fi network.
const char* AP_SSID = "PlantMonitor";
const char* AP_PASS = "plant1234";
WebServer server(80);
const int PUMP_PIN = 5;

const char INDEX_HTML[] PROGMEM = R"rawliteral(<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plant Monitor</title>
</head>
<body><h1>Plant</h1><button onclick="fetch('/pump')">Water</button></body>
</html>)rawliteral";

void handleRoot() { server.send_P(200, "text/html", INDEX_HTML); }
void handlePump() {
  digitalWrite(PUMP_PIN, HIGH);
  server.send(200, "text/plain", "ok");
}

void setup() {
  Serial.begin(115200);
  pinMode(PUMP_PIN, OUTPUT);
  WiFi.softAP(AP_SSID, AP_PASS);
  server.on("/", handleRoot);
  server.on("/pump", handlePump);
  server.begin();
}

void loop() {
  server.handleClient();
}
`;

console.log("A board that serves its own page (WebServer)");
{
  const p = inspectProject(WEB);
  check(p.board?.kind === "WebServer" && p.board.variable === "server", "the server is found", JSON.stringify(p.board));
  check(p.hasPage && p.wifi && !p.ble && !p.cloud && !p.applied, "page and Wi-Fi seen, nothing else");
  const r = applyApp(WEB, settings);
  check(r.ok, "the app is added", r.ok ? "" : r.reason);
  const out = r.code;
  keep("web.cpp", out);
  check(/#include <WebServer.h>\n#include <JointAgentApp.h>\n/.test(out), "#include right after the server's own");
  check(/  \/\/ Lets a phone add[^\n]*\n  JointAgentApp::serve\(server, "Plant Monitor", "Plant", "#0f766e", "standalone"\);\n  server.on\("\/", handleRoot\);/.test(out),
    "serve(...) before the first route, same indent, colour lower-cased");
  check(out.includes("<head><!-- Joint-Agent app --><link rel='manifest' href='/manifest.webmanifest'>"), "tags just inside <head>");
  check(out.includes("<meta name='apple-mobile-web-app-title' content='Plant'>") && out.includes("<link rel='apple-touch-icon' href='/apple-touch-icon.png'>"),
    "iPhone title and icon tags");
  check(!out.includes("black-translucent"), "status bar kept for an app window");
  check(usesAppHelper(out) && !usesAppHelper(WEB), "a compile knows to add the helper");
  check(inspectProject(out).applied, "seen as applied");
  check(removeApp(out) === WEB, "removing gives back the sketch exactly");
  const again = applyApp(out, settings);
  check(again.ok && again.code === out, "applying twice changes nothing more");
  const renamed = applyApp(out, { ...settings, name: "Garden", shortName: "Garden", display: "fullscreen" });
  check(renamed.ok && (renamed.code.match(/JointAgentApp::serve/g) || []).length === 1 && renamed.code.includes('"Garden", "Garden", "#0f766e", "fullscreen"'),
    "a new name replaces the old one, never a second line");
  check(renamed.ok && (renamed.code.match(/<!-- Joint-Agent app -->/g) || []).length === 1 && renamed.code.includes("black-translucent"),
    "one set of tags, full screen on iPhone too");
  const read = appliedSettings(out);
  check(read?.name === "Plant Monitor" && read.shortName === "Plant" && read.themeColor === "#0f766e" && read.display === "standalone",
    "the form starts from what was applied", JSON.stringify(read));
  check(extractHtml(out)?.includes("rel='manifest'"), "Web Preview still finds the page");
}

const ASYNC = `#include <Arduino.h>
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include "DHT.h"

DHT dht(4, DHT11);
AsyncWebServer server(80);

const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE HTML><html><head><title>Temp</title></head>
<body><p>Temperature: %TEMPERATURE% &deg;C</p><p>Battery %d%%</p></body></html>)rawliteral";

String processor(const String& var) {
  if (var == "TEMPERATURE") return String(dht.readTemperature());
  return String();
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  WiFi.begin("home", "secret123");
  while (WiFi.status() != WL_CONNECTED) delay(500);
  server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send_P(200, "text/html", index_html, processor);
  });
  server.begin();
}

void loop() {}
`;

console.log("A board that serves its own page (ESPAsyncWebServer)");
{
  const p = inspectProject(ASYNC);
  check(p.board?.kind === "AsyncWebServer" && p.board.variable === "server", "the async server is found");
  const r = applyApp(ASYNC, { ...settings, name: "Victor's Temp & Fan", shortName: "Temp" });
  check(r.ok, "the app is added", r.ok ? "" : r.reason);
  keep("async.cpp", r.code);
  check(r.code.includes("#include <ESPAsyncWebServer.h>\n#include <JointAgentAppAsync.h>\n"), "the async helper is included");
  check(r.code.includes('JointAgentApp::serve(server, "Victor\'s Temp & Fan", "Temp", "#0f766e", "standalone");'), "the name as typed, in the C++ string");
  const tags = /<!-- Joint-Agent app -->.*?<!-- \/Joint-Agent app -->/.exec(r.code)?.[0] ?? "";
  check(!tags.includes("%"), "no % in the tags, which the page's processor would read as a placeholder");
  check(removeApp(r.code) === ASYNC, "removing gives back the sketch exactly");
  const html = extractHtml(r.code);
  check(fillRuntimePlaceholders(html).includes("⟨temperature⟩") && fillRuntimePlaceholders(html).includes("Battery ⟨value⟩%"),
    "the preview's placeholders still read the same");
}
{
  const tags = appHeadTags({ ...settings, shortName: "Al's & Co" });
  check(tags.includes("content='Al&#39;s &amp; Co'"), "' and & are written safely in the page's tags");
}

console.log("Pages built a piece at a time, and odd layouts");
{
  const code = `#include <WiFi.h>
#include <WebServer.h>
WebServer web(80);
void handleRoot() {
  String html = "<!DOCTYPE html><html><head><title>Fan</title>";
  html += "</head><body><a href=\\"/on\\">On</a></body></html>";
  web.send(200, "text/html", html);
}
void setup() {
  WiFi.softAP("Fan", "fan12345");
  web.on("/", handleRoot);
  web.begin();
}
void loop() { web.handleClient(); }
`;
  const r = applyApp(code, settings);
  check(r.ok && r.code.includes(`"<!DOCTYPE html><html><head><!-- Joint-Agent app -->`), "tags inside an ordinary string", r.ok ? "" : r.reason);
  check(r.ok && r.code.includes('JointAgentApp::serve(web, "Plant Monitor"'), "a server called web");
  check(r.ok && removeApp(r.code) === code, "removed exactly");
  keep("pieces.cpp", r.code);
}
{
  const code = `#include <WiFi.h>\r\n#include <WebServer.h>\r\nWebServer server(80);\r\nconst char PAGE[] = R"(<html><body>Hi</body></html>)";\r\nvoid setup() {\r\n  server.on("/", []() { server.send(200, "text/html", PAGE); });\r\n  server.begin();\r\n}\r\nvoid loop() { server.handleClient(); }\r\n`;
  const r = applyApp(code, settings);
  check(r.ok && r.code.includes("<html><head><!-- Joint-Agent app (head) -->") && r.code.includes("<!-- /Joint-Agent app --></head><body>"),
    "a page with no <head> gets one", r.ok ? "" : r.reason);
  check(r.ok && r.code.includes("#include <JointAgentApp.h>\r\n") && r.code.includes("JointAgentApp::serve(server, \"Plant Monitor\", \"Plant\", \"#0f766e\", \"standalone\");\r\n"),
    "Windows line endings kept");
  check(r.ok && removeApp(r.code) === code, "removed exactly, <head> too");
  keep("nohead.cpp", r.code.replace(/\r\n/g, "\n"));
}
{
  const code = `#include <WiFi.h>
#include <WebServer.h>
WebServer server(80);
bool extra = true;
const char PAGE[] = "<html><head></head><body>x</body></html>";
void setup() {
  if (extra)
    server.on("/extra", []() { server.send(200, "text/plain", "x"); });
  server.on("/", []() { server.send(200, "text/html", PAGE); });
  server.begin();
}
void loop() { server.handleClient(); }
`;
  const r = applyApp(code, settings);
  check(r.ok && /\{\n  if \(extra\)\n    server\.on\("\/extra"/.test(r.code), "never between an if and the line it covers");
  check(r.ok && /\);\n  \/\/ Lets a phone[^\n]*\n  JointAgentApp::serve\(server[^\n]*\n  server\.on\("\/", /.test(r.code), "placed at the next safe route instead");
  keep("ifroute.cpp", r.code);
}
{
  const code = `#include <WiFi.h>
// #include <WebServer.h>
// WebServer server(80);
const char PAGE[] = "<html><head></head><body>x</body></html>";
void setup() {}
void loop() {}
`;
  const p = inspectProject(code);
  check(p.board === null && p.hasPage, "a commented-out server doesn't count");
  check(!applyApp(code, settings).ok, "and nothing is changed");
}

console.log("Pages the app can't be added to automatically");
{
  const raw = `#include <WiFi.h>
WiFiServer server(80);
void setup() { server.begin(); }
void loop() {
  WiFiClient client = server.available();
  if (client) { client.println("<!DOCTYPE html><html><head></head><body>x</body></html>"); }
}`;
  const p = inspectProject(raw);
  check(p.board === null && /WiFiServer/.test(p.boardProblem ?? ""), "a hand-written WiFiServer page: told why");
  const ptr = `#include <WebServer.h>
WebServer* server;
const char PAGE[] = "<html><head></head></html>";
void setup() { server = new WebServer(80); server->begin(); }
void loop() {}`;
  check(/with new/.test(inspectProject(ptr).boardProblem ?? ""), "a server made with new: told why");
  const fsPage = `#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
AsyncWebServer server(80);
void setup() { LittleFS.begin(); server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html"); server.begin(); }
void loop() {}`;
  const fp = inspectProject(fsPage);
  check(fp.board === null && /file storage/.test(fp.boardProblem ?? ""), "a page in the board's files: told why");
}

console.log("Bluetooth, mobile data and cloud projects");
{
  const ble = inspectProject(`#include <BLEDevice.h>\n#include <BLEServer.h>\nvoid setup(){}\nvoid loop(){}`);
  check(ble.ble && !ble.board && !ble.classicBluetooth, "BLE");
  const nimble = inspectProject(`#include <NimBLEDevice.h>\nvoid setup(){}\nvoid loop(){}`);
  check(nimble.ble, "NimBLE");
  const classic = inspectProject(`#include "BluetoothSerial.h"\nBluetoothSerial SerialBT;\nvoid setup(){}\nvoid loop(){}`);
  check(classic.classicBluetooth && !classic.ble, "Classic Bluetooth (ESP32 BluetoothSerial)");
  const hc05 = inspectProject(`#include <SoftwareSerial.h>
SoftwareSerial BTSerial(10, 11); // RX | TX
void setup() { BTSerial.begin(9600); pinMode(13, OUTPUT); }
void loop() { if (BTSerial.available()) { char c = BTSerial.read(); digitalWrite(13, c == '1'); } }`);
  check(hc05.classicBluetooth && !hc05.ble && !hc05.wifi, "an HC-05 on an Uno, known by its serial port's name");
  const named = inspectProject(`// Bluetooth lamp with an HC-06 on Serial1 (Mega)\nvoid setup() { Serial1.begin(9600); }\nvoid loop() {}`);
  check(named.classicBluetooth, "an HC-06 known by name in a comment");
  const hm10 = inspectProject(`#include <SoftwareSerial.h>\n// HM-10 BLE module\nSoftwareSerial bt(2, 3);\nvoid setup() { bt.begin(9600); }\nvoid loop() {}`);
  check(hm10.ble && !hm10.classicBluetooth, "an HM-10 is Bluetooth Low Energy, not Classic");
  const button = inspectProject(`#include <Bounce2.h>\nBounce btn;\nvoid setup() { btn.attach(2); }\nvoid loop() { btn.update(); if (btn.read()) {} }`);
  check(!button.classicBluetooth && !button.ble, "a button called btn isn't Bluetooth");
  const sr04 = inspectProject(`// HC-SR04 distance sensor\nvoid setup() { Serial.begin(9600); }\nvoid loop() {}`);
  check(!sr04.classicBluetooth, "an HC-SR04 sensor isn't an HC-05");
  const gsm = inspectProject(`#define TINY_GSM_MODEM_SIM800\n#include <TinyGsmClient.h>\n#include <PubSubClient.h>\nvoid setup(){}\nvoid loop(){}`);
  check(gsm.cellular && gsm.cloud, "SIM module with MQTT");
  const cloud = inspectProject(`#include <WiFi.h>\n#include <HTTPClient.h>\nvoid setup(){}\nvoid loop(){}`);
  check(cloud.cloud && cloud.wifi && !cloud.cellular && !cloud.hasPage, "Wi-Fi with a web service, no page");
  const none = inspectProject(`void setup(){ pinMode(13, OUTPUT); }\nvoid loop(){}`);
  check(!none.ble && !none.cloud && !none.wifi && !none.hasPage && !none.cellular && !none.classicBluetooth, "a blink sketch: nothing");
}

console.log("App names");
{
  check(cleanAppName(`  Plant "Monitor" 100% <b>\\ ok?  `) === "Plant Monitor 100 b ok", "quotes, %, <>, \\ and ? removed", JSON.stringify(cleanAppName(`  Plant "Monitor" 100% <b>\\ ok?  `)));
  check(cleanAppName("Ọgbọ́nna's Lamp & Fan") === "Ọgbọ́nna's Lamp & Fan", "letters with accents, ' and & kept");
  check(cleanAppName("x".repeat(50)).length === 30 && cleanAppName("Greenhouse Watcher", 12) === "Greenhouse W", "cut to length");
  check(!applyApp(WEB, { ...settings, name: '""' }).ok, "a name with nothing left is refused");
  const fallback = applyApp(WEB, { ...settings, shortName: "" });
  check(fallback.ok && fallback.code.includes('"Plant Monitor", "Plant", '), "no short name: the name's first words that fit");
  check(shortNameFrom("Greenhouse Watcher") === "Greenhouse" && shortNameFrom("Supercalifragilistic") === "Supercalifra" && shortNameFrom("My Fan") === "My Fan",
    "home-screen names from whole words");
  const badColour = applyApp(WEB, { ...settings, themeColor: "red;}" });
  check(badColour.ok && badColour.code.includes('"#0b0d12"'), "a colour that isn't #rrggbb isn't used");
}

console.log("The helper");
{
  const png = fs.readFileSync(new URL("../public/icons/icon-192.png", import.meta.url));
  const embedded = Buffer.from(APP_ICON_PNG_BASE64, "base64");
  check(embedded.equals(png), "the server's icon is exactly public/icons/icon-192.png", `${embedded.length} bytes`);
  const files = appHelperFiles(new Uint8Array(png));
  const core = files.find((f) => f.name === "JointAgentAppCore.h").content;
  const array = core.slice(core.indexOf("ICON_PNG[] PROGMEM = {"), core.indexOf("};"));
  const bytes = (array.match(/0x[0-9a-f]{2}/g) || []).map((h) => parseInt(h, 16));
  check(Buffer.from(bytes).equals(png), "the header holds the icon's bytes, in order");
  check(files.map((f) => f.name).join() === "JointAgentAppCore.h,JointAgentApp.h,JointAgentAppAsync.h", "three headers");
  const dir = fs.mkdtempSync(path.join((await import("os")).tmpdir(), "appkit-"));
  check(addAppHelper(WEB, dir) === false && !fs.existsSync(path.join(dir, "include")), "a compile of any other sketch: nothing written");
  const applied = applyApp(WEB, settings);
  check(addAppHelper(applied.code, dir) === true && fs.readdirSync(path.join(dir, "include")).sort().join() === "JointAgentApp.h,JointAgentAppAsync.h,JointAgentAppCore.h",
    "a compile of an app sketch: the headers beside it");
  fs.rmSync(dir, { recursive: true, force: true });
  check(!usesAppHelper("// #include <JointAgentApp.h>\nvoid setup(){}") && usesAppHelper('#include "JointAgentApp.h"\n'), "only a real #include counts");
}

console.log("The app package");
{
  const { appSlug, crc32, zip, prepareAppPage, appManifest, appPackageFiles, appServiceWorker } = await import("../src/lib/appPackage.ts");
  check(crc32(new TextEncoder().encode("123456789")) === 0xcbf43926, "CRC-32 of the standard check string");
  check(appSlug("Ọgbọ́nna's Lamp") === "ogbonnas-lamp" && appSlug("!!!") === "app" && appSlug("Plant  Monitor 2") === "plant-monitor-2", "folder names", appSlug("Ọgbọ́nna's Lamp"));
  const page = prepareAppPage(`<!DOCTYPE html><html><head><title>X</title><link rel="manifest" href="/m.json"><link rel="stylesheet" href="s.css"><meta name="theme-color" content="#000"></head><body>x</body></html>`, settings);
  check(!page.includes("/m.json") && !page.includes('content="#000"') && page.includes('href="s.css"'), "the agent's own manifest and colour tags replaced, others kept");
  check((page.match(/rel="manifest"/g) || []).length === 1 && page.includes('<meta charset="utf-8">') && page.includes('serviceWorker.register("sw.js")'), "one manifest, a charset, the worker");
  const bare = prepareAppPage("<p>hi</p>", settings);
  check(bare.startsWith("<!DOCTYPE html>") && bare.includes("<body>\n<p>hi</p>"), "a fragment is wrapped in a page");
  const m = JSON.parse(appManifest({ ...settings, themeColor: "#0f766e" }));
  check(m.start_url === "./" && m.scope === "./" && m.icons.length === 2 && m.icons.every((i) => i.purpose === "any") && m.theme_color === "#0f766e", "manifest: relative, regular icons");
  check(appServiceWorker("v9").includes('const CACHE = "app-v9";'), "a new cache name for each build");
  const png = new Uint8Array(fs.readFileSync(new URL("../public/icons/icon-192.png", import.meta.url)));
  const files = appPackageFiles({ html: "<html><head></head><body>x</body></html>", notes: "", settings, kind: "internet", icon192: png, icon512: png, version: "t" });
  check(files.map((f) => f.name).join() === "plant-monitor/index.html,plant-monitor/manifest.webmanifest,plant-monitor/sw.js,plant-monitor/icons/icon-192.png,plant-monitor/icons/icon-512.png,plant-monitor/README.txt",
    "the package's files, in a folder named after the app");
  const z = zip(files, new Date(2026, 9, 3, 12, 30, 10));
  const v = new DataView(z.buffer);
  const end = z.length - 22;
  check(v.getUint32(end, true) === 0x06054b50 && v.getUint16(end + 10, true) === files.length, "zip: the end record counts every file");
  const cdAt = v.getUint32(end + 16, true);
  check(v.getUint32(cdAt, true) === 0x02014b50 && v.getUint32(0, true) === 0x04034b50, "zip: the file list is where the end record says");
  let at = 0, same = true;
  for (const f of files) {
    const nameLen = v.getUint16(at + 26, true);
    const size = v.getUint32(at + 18, true);
    const body = z.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    if (v.getUint32(at + 14, true) !== crc32(f.data) || Buffer.compare(Buffer.from(body), Buffer.from(f.data)) !== 0) same = false;
    at += 30 + nameLen + size;
  }
  check(same && at === cdAt, "zip: every file stored whole, with its CRC");
  const readme = new TextDecoder().decode(files[5].data);
  check(/Netlify Drop/.test(readme) && /iPhone/.test(readme) && /typed into the app's settings/.test(readme), "README: how to put it online and install it");
  const { appReadme } = await import("../src/lib/appPackage.ts");
  const classicReadme = appReadme(settings, "classic", "");
  check(/pair the board/i.test(classicReadme) && /1234 or 0000/.test(classicReadme) && /iPhone and iPad can't connect to Classic/.test(classicReadme) && /Chrome on Android/.test(classicReadme),
    "README for Classic Bluetooth: pair first, where it works, not iPhone");
  const bleReadme = appReadme(settings, "bluetooth", "");
  check(/Bluetooth Low Energy/.test(bleReadme) && !/Edge on Android/.test(bleReadme), "README for BLE: Chrome on Android (not Edge)");
}

if (bad) {
  console.log(`\n${bad} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Build App checks passed");
