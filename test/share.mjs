/**
 * What a shared link shows: the project's name, board, description, code
 * and circuit, never the conversation or who owns it, and never a secret
 * in the code.
 */
import { sharedView } from "../server/share.ts";

let bad = 0;
const check = (cond, label, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

const project = {
  name: "Garden monitor",
  description: "Reads soil moisture and posts it.",
  mcu: "esp32",
  boardId: "esp32dev",
  code: '#include <WiFi.h>\nconst char* ssid = "MyHome";\nconst char* password = "garden2024";\nvoid setup() { WiFi.begin(ssid, password); }\nvoid loop() {}\n',
  components: [{ id: "s1", type: "potentiometer", label: "Soil sensor" }],
  connections: [{ id: "w1", fromComponentId: "s1", fromPin: "SIG", toComponentId: "mcu", toPin: "D34", color: "#3B82F6" }],
  messages: [{ role: "user", content: "my wifi password is garden2024" }],
  uid: "owner-uid-123",
  shareSecretField: "x",
  updatedAt: { toMillis: () => 1759000000000 },
};

const view = sharedView(project);
const json = JSON.stringify(view);
check(view.name === "Garden monitor" && view.boardId === "esp32dev" && view.mcu === "esp32", "name and board are shown");
check(view.components.length === 1 && view.connections.length === 1, "the circuit is shown");
check(!("messages" in view) && !json.includes("my wifi password"), "the conversation is never shared");
check(!json.includes("owner-uid-123") && !("uid" in view), "nothing says whose project it is");
check(!json.includes("garden2024") && !json.includes("MyHome"), "the WiFi name and password are hidden");
check(view.code.includes("WiFi.begin(ssid, password)"), "the rest of the code is intact");
check(view.updatedAt === 1759000000000, "when it was last changed");
check(Object.keys(view).sort().join(",") === "boardId,code,components,connections,description,mcu,name,updatedAt", "only these fields, nothing else from the project", Object.keys(view).join(","));

const odd = sharedView({ name: 42, code: null, components: "x", connections: undefined, mcu: "nonsense" });
check(odd.name === "Untitled Project" && odd.code === "" && Array.isArray(odd.components) && Array.isArray(odd.connections) && odd.mcu === "arduino",
  "odd data is shown safely");

console.log(bad ? `\n${bad} FAILED` : "\nall ok");
process.exit(bad ? 1 : 0);
