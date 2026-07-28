import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "plugin.yaml");
const modulePath = resolve(root, "dap_meeting_assistant/plugin.mjs");
const palettePath = resolve(root, "palette/index.html");

for (const file of [manifestPath, modulePath, palettePath]) {
  if (!existsSync(file)) throw new Error(`required plugin file is missing: ${file}`);
}

const manifest = readFileSync(manifestPath, "utf8");
for (const expected of [
  "id: dap.meeting_assistant",
  "version: 1.0.2",
  "entry: dap_meeting_assistant.plugin:activate",
  "min_app_version: 1.3.12",
  "  - meeting.capture",
  "  - storage.private",
  "  - window.palette",
]) {
  if (!manifest.includes(expected)) throw new Error(`manifest contract is missing: ${expected}`);
}
if (!manifest.includes("execution_modes:") || !manifest.includes("  - user") || manifest.includes("  - builtin")) {
  throw new Error("external plugin manifest must declare user execution only");
}

const pluginModule = await import(pathToFileURL(modulePath).href);
if (typeof pluginModule.activate !== "function") throw new Error("activate export is missing");

const contributions = [];
const cleanup = pluginModule.activate({
  pluginId: "dap.meeting_assistant",
  host: {
    bubble: { speak() {} },
    clipboard: { writeText() {} },
    llm: { async generate() { return ""; } },
    settings: { values() { return {}; }, set() {} },
    storage: {},
    windows: {},
  },
  settings: {
    registerSettingsSection(value) {
      contributions.push(["settings", value.sectionId]);
    },
  },
  actions: {
    registerAction(value) {
      contributions.push(["action", value.id]);
    },
  },
  radialMenu: {
    addItem(value) {
      contributions.push(["radial", value.itemId]);
    },
  },
  trayMenu: {
    addItem(value) {
      contributions.push(["tray", value.itemId]);
    },
  },
});

const expectedContributions = [
  ["settings", "general"],
  ["action", "openMeetingAssistant"],
  ["radial", "meeting"],
  ["tray", "open"],
];
if (JSON.stringify(contributions) !== JSON.stringify(expectedContributions)) {
  throw new Error(`unexpected contributions: ${JSON.stringify(contributions)}`);
}
if (typeof cleanup !== "function") throw new Error("activate must return a cleanup function");

console.log("✓ meeting assistant plugin contract and activation smoke passed");
