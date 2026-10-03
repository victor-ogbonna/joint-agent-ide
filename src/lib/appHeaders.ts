/**
 * The helper that lets a phone add a board's web page to its home screen as
 * an app ("Build App (PWA)", when the board serves the page itself).
 *
 * A phone needs three things from the page's server for that: a manifest
 * (the app's name, colour and how it opens) and an icon, under the names it
 * asks for. They live in these headers rather than in the user's sketch:
 * the icon alone is 14 KB of bytes, which would swamp the code the user
 * reads and the agent rewrites. The sketch gets one #include and one
 * JointAgentApp::serve(...) line; compiles add these files beside it, and
 * a GitHub export adds them to the repository.
 *
 * Shared by the server (compiles) and the app (exports), so the two can
 * never differ. The icon bytes are passed in: the server has its own copy
 * (server/appIcon.ts), the app fetches /icons/icon-192.png.
 */

/** For a sketch using the ESP32's own WebServer. */
export const APP_HEADER = "JointAgentApp.h";
/** For a sketch using ESPAsyncWebServer. */
export const APP_HEADER_ASYNC = "JointAgentAppAsync.h";
/** What both share: the icon and the manifest. */
export const APP_HEADER_CORE = "JointAgentAppCore.h";

const INCLUDE = /^[ \t]*#[ \t]*include[ \t]*[<"](JointAgentApp|JointAgentAppAsync)\.h[>"]/m;

/** Whether a sketch includes the helper, so a build or export needs its files. */
export function usesAppHelper(code: string): boolean {
  return INCLUDE.test(code);
}

/** Bytes as a C array body: 16 to a line. */
function cBytes(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row: string[] = [];
    for (const b of bytes.subarray(i, i + 16)) row.push(`0x${b.toString(16).padStart(2, "0")}`);
    lines.push(`  ${row.join(", ")},`);
  }
  return lines.join("\n");
}

const NOTE = `// Added by Joint-Agent IDE's "Build App (PWA)". It lets a phone add this
// board's page to its home screen as an app, with the Joint-Agent icon.`;

function coreHeader(iconPng: Uint8Array): string {
  return `${NOTE}
#pragma once
#include <Arduino.h>

namespace JointAgentApp {

// The app's icon: the Joint-Agent logo, a 192 x 192 PNG.
static const uint8_t ICON_PNG[] PROGMEM = {
${cBytes(iconPng)}
};
static const size_t ICON_PNG_SIZE = sizeof(ICON_PNG);

// Text made safe to sit inside a JSON string.
inline String jsonText(const char* text) {
  String out;
  for (const char* p = text; p && *p; ++p) {
    const char c = *p;
    if (c == '"' || c == '\\\\') {
      out += '\\\\';
      out += c;
    } else if ((unsigned char)c >= 0x20) {
      out += c;
    }
  }
  return out;
}

// The manifest a phone reads: the app's name, its colour, how it opens
// ("standalone" or "fullscreen") and its icon.
inline String manifest(const char* name, const char* shortName, const char* themeColor, const char* display) {
  String json = "{\\"id\\":\\"/\\",\\"name\\":\\"";
  json += jsonText(name);
  json += "\\",\\"short_name\\":\\"";
  json += jsonText(shortName);
  json += "\\",\\"start_url\\":\\"/\\",\\"scope\\":\\"/\\",\\"display\\":\\"";
  json += jsonText(display);
  json += "\\",\\"theme_color\\":\\"";
  json += jsonText(themeColor);
  json += "\\",\\"background_color\\":\\"#ffffff\\",\\"icons\\":[{\\"src\\":\\"/app-icon.png\\",\\"sizes\\":\\"192x192\\",\\"type\\":\\"image/png\\",\\"purpose\\":\\"any\\"}]}";
  return json;
}

}  // namespace JointAgentApp
`;
}

const WEB_SERVER_HEADER = `${NOTE}
#pragma once
#include <Arduino.h>
#include <WebServer.h>
#include "${APP_HEADER_CORE}"

namespace JointAgentApp {

// Serves the app's manifest and icon from this web server. Call it in
// setup(), before server.begin().
inline void serve(WebServer& server, const char* name, const char* shortName, const char* themeColor, const char* display = "standalone") {
  const String json = manifest(name, shortName, themeColor, display);
  server.on("/manifest.webmanifest", HTTP_GET, [&server, json]() {
    server.send(200, "application/manifest+json", json);
  });
  // The icon, also under the name iPhones and iPads look for.
  const char* iconPaths[] = { "/app-icon.png", "/apple-touch-icon.png" };
  for (const char* iconPath : iconPaths) {
    server.on(iconPath, HTTP_GET, [&server]() {
      server.sendHeader("Cache-Control", "max-age=86400");
      server.send_P(200, "image/png", (const char*)ICON_PNG, ICON_PNG_SIZE);
    });
  }
}

}  // namespace JointAgentApp
`;

const ASYNC_SERVER_HEADER = `${NOTE}
#pragma once
#include <Arduino.h>
#include <ESPAsyncWebServer.h>
#include "${APP_HEADER_CORE}"

namespace JointAgentApp {

// Serves the app's manifest and icon from this web server. Call it in
// setup(), before server.begin().
inline void serve(AsyncWebServer& server, const char* name, const char* shortName, const char* themeColor, const char* display = "standalone") {
  const String json = manifest(name, shortName, themeColor, display);
  server.on("/manifest.webmanifest", HTTP_GET, [json](AsyncWebServerRequest* request) {
    request->send(200, "application/manifest+json", json);
  });
  // The icon, also under the name iPhones and iPads look for.
  const char* iconPaths[] = { "/app-icon.png", "/apple-touch-icon.png" };
  for (const char* iconPath : iconPaths) {
    server.on(iconPath, HTTP_GET, [](AsyncWebServerRequest* request) {
      AsyncWebServerResponse* response = request->beginResponse_P(200, "image/png", ICON_PNG, ICON_PNG_SIZE);
      response->addHeader("Cache-Control", "max-age=86400");
      request->send(response);
    });
  }
}

}  // namespace JointAgentApp
`;

/** The helper's files, by name, with the icon given as PNG bytes. */
export function appHelperFiles(iconPng: Uint8Array): { name: string; content: string }[] {
  return [
    { name: APP_HEADER_CORE, content: coreHeader(iconPng) },
    { name: APP_HEADER, content: WEB_SERVER_HEADER },
    { name: APP_HEADER_ASYNC, content: ASYNC_SERVER_HEADER },
  ];
}
