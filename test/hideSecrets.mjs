/**
 * A shared project's code never shows its passwords, keys or tokens, and
 * everything else in it stays as it was.
 */
import { hideSecrets, HIDDEN } from "../server/hideSecrets.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};
const hidden = (code, secret, label) => {
  const out = hideSecrets(code);
  check(!out.includes(secret) && out.includes(HIDDEN), `hidden: ${label}`, out.includes(secret) ? JSON.stringify(out) : "");
};
const kept = (code, text, label) => {
  const out = hideSecrets(code);
  check(out.includes(text), `kept: ${label}`, out.includes(text) ? "" : JSON.stringify(out));
};

console.log("WiFi and logins");
hidden('const char* ssid = "HomeNet-5G";\nconst char* password = "hunter22";', "hunter22", "a password variable");
hidden('const char* ssid = "HomeNet-5G";', "HomeNet-5G", "the WiFi network name");
hidden('#define WIFI_PASSWORD "s3cret!"\n', "s3cret!", "a #define");
hidden('#define WIFI_SSID   "Cafe"\n#define WIFI_PASS "latte123"\n', "latte123", "#defines one after another");
hidden('char pass[] PROGMEM = "abc12345";', "abc12345", "an array with PROGMEM");
hidden('String apiKey = "k_live_8f9";', "k_live_8f9", "an API key");
hidden('const char *mqtt_user = "sensor";\nconst char *mqtt_pwd = "pa55";', "pa55", "MQTT login");
hidden('void setup() {\n  WiFi.begin("MyNetwork", "MyPassword1");\n}', "MyPassword1", "straight into WiFi.begin");
hidden('void setup() {\n  WiFi.begin("MyNetwork", "MyPassword1");\n}', "MyNetwork", "and the network name with it");
hidden('WiFi.softAP("ESP32-AP", "12345678");', "12345678", "an access point's password");
hidden('if (!client.connect("esp32-client", "admin", "letmein")) {}', "letmein", "an MQTT connect with user and password");
hidden('String token("tok_ABC");', "tok_ABC", "constructed with a secret name");
hidden('if (pin == "4821") unlock();', "4821", "compared with a secret name");
hidden('struct Net { const char* ssid; const char* pass; };\nNet creds[] = {\n  {"Home", "homepass1"},\n  {"Office", "officepass2"}\n};', "officepass2", "a list of networks");
hidden('#define USER_EMAIL "maker@example.com"\n', "maker@example.com", "an email address");

console.log("Keys and tokens wherever they are");
hidden('#define FIREBASE_URL "x"\nFirebase.begin("x", "AIzaSyD4f8Kq9Xv2Lw0Jc3Rt6Yu1Io5Pa7Sd8Fg");', "AIzaSyD4f8Kq9Xv2Lw0Jc3Rt6Yu1Io5Pa7Sd8Fg", "a Google API key");
hidden('bot.sendMessage(chat, "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");', "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "a Telegram bot token");
hidden('const char* root_ca = R"EOF(\n-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJJ\n-----END CERTIFICATE-----\n)EOF";', "MIIDdzCCAl", "a certificate in a raw string");
hidden('http.begin("https://api.thingspeak.com/update?api_key=Q8W2E4R6T8Y0&field1=" + String(t));', "Q8W2E4R6T8Y0", "an api_key in a URL");
hidden('http.begin("http://admin:router99@192.168.1.1/status");', "router99", "a password in a URL");
kept('http.begin("http://admin:router99@192.168.1.1/status");', "192.168.1.1/status", "the rest of that URL");

console.log("Everything else stays");
kept('Serial.println("Temperature: ");', "Temperature: ", "a message");
kept('lcd.print("Enter password:");', "Enter password:", "a prompt that mentions a password");
kept('const char* mqtt_server = "broker.hivemq.com";', "broker.hivemq.com", "a server name");
kept('client.setServer("broker.hivemq.com", 1883);', "broker.hivemq.com", "a server passed to a call");
kept('#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"', "4fafc201-1fb5-459e-8fcc-c5c9c331914b", "a Bluetooth UUID");
kept('server.on("/login", handleLogin);', "/login", "a web route");
kept('#define API_VERSION 2\nString greeting = "hello there";', "hello there", "a string after an unrelated #define");
kept('char keys[4][4] = {{\'1\',\'2\',\'3\',\'A\'}};', "'A'", "a keypad map");
kept('// password is hunter22 (comments are left alone)', "hunter22", "comments");
kept('const char index_html[] PROGMEM = R"rawliteral(<!DOCTYPE html><html><body><h1>ESP Web Server</h1></body></html>)rawliteral";', "<h1>ESP Web Server</h1>", "a web page");
kept('Serial.println("He said \\"hi\\"");\nconst char* ssid = "Net";', 'He said \\"hi\\"', "escaped quotes");

console.log("A whole sketch");
{
  const sketch = `#include <WiFi.h>
#include <PubSubClient.h>

// Network
const char* ssid = "Cafe-Guest";
const char* password = "espresso42";
const char* mqtt_server = "test.mosquitto.org";

WiFiClient espClient;
PubSubClient client(espClient);

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  client.setServer(mqtt_server, 1883);
}

void loop() {
  if (!client.connected()) client.connect("esp32", "mqttuser", "mqttpass9");
  client.publish("home/temp", "21.5");
}
`;
  const out = hideSecrets(sketch);
  check(!out.includes("Cafe-Guest") && !out.includes("espresso42") && !out.includes("mqttpass9"), "no network name or password left");
  check(out.includes("test.mosquitto.org") && out.includes('"home/temp"') && out.includes('"21.5"') && out.includes('Serial.print(".")'), "everything else as it was");
  check(out.split("\n").length === sketch.split("\n").length, "the same number of lines");
  check(hideSecrets("") === "" && hideSecrets(undefined) === "", "empty code stays empty");
}

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
