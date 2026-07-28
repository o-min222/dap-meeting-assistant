import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "plugin.yaml");
const modulePath = resolve(root, "dap_meeting_assistant/plugin.mjs");
const palettePath = resolve(root, "palette/index.html");
const iconPath = resolve(root, "assets/icon.png");

for (const file of [manifestPath, modulePath, palettePath, iconPath]) {
  if (!existsSync(file)) throw new Error(`required plugin file is missing: ${file}`);
}
const icon = readFileSync(iconPath);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!icon.subarray(0, 8).equals(pngSignature)) {
  throw new Error("assets/icon.png must be a PNG image");
}
if (icon.readUInt32BE(16) !== 512 || icon.readUInt32BE(20) !== 512) {
  throw new Error("assets/icon.png must be 512 × 512");
}
if (icon[25] !== 6) {
  throw new Error("assets/icon.png must use RGBA color for transparent corners");
}
if (icon.length > 512 * 1024) {
  throw new Error("assets/icon.png exceeds the DAP radial icon size limit");
}

const manifest = readFileSync(manifestPath, "utf8");
for (const expected of [
  "id: dap.meeting_assistant",
  "version: 1.0.5",
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
const actions = new Map();
const paletteMessages = [];
const captureSources = [];
let paletteReceive = null;
let statusListener = null;
const meeting = {
  capabilities() {
    return { available: true, sources: ["both", "microphone", "system"] };
  },
  onStatus(callback) {
    statusListener = callback;
    return () => {};
  },
  onTranscript() {
    return () => {};
  },
  async start(options) {
    captureSources.push(options.source);
    statusListener?.({ state: "starting", source: options.source });
    if (options.source === "both") {
      statusListener?.({ state: "error", source: options.source, error: "Permission denied" });
      throw new Error("Permission denied");
    }
    const status = { state: "listening", source: options.source, sessionId: "smoke-session" };
    statusListener?.(status);
    return status;
  },
};
const cleanup = pluginModule.activate({
  pluginId: "dap.meeting_assistant",
  host: {
    bubble: { speak() {} },
    clipboard: { writeText() {} },
    llm: { async generate() { return ""; } },
    settings: { values() { return {}; }, set() {} },
    storage: {
      async getJson() { return null; },
      async setJson() {},
    },
    meeting,
    windows: {
      openPalette() {
        return {
          isDestroyed() { return false; },
          toggle() {},
          onMessage(callback) { paletteReceive = callback; },
          postMessage(message) { paletteMessages.push(message); },
        };
      },
    },
  },
  settings: {
    registerSettingsSection(value) {
      contributions.push(["settings", value.sectionId]);
    },
  },
  actions: {
    registerAction(value) {
      actions.set(value.id, value.callback);
      contributions.push(["action", value.id]);
    },
  },
  radialMenu: {
    addItem(value) {
      contributions.push(["radial", value.itemId, value.icon]);
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
  ["radial", "meeting", "assets/icon.png"],
  ["tray", "open"],
];
if (JSON.stringify(contributions) !== JSON.stringify(expectedContributions)) {
  throw new Error(`unexpected contributions: ${JSON.stringify(contributions)}`);
}
if (typeof cleanup !== "function") throw new Error("activate must return a cleanup function");

actions.get("openMeetingAssistant")?.();
paletteReceive?.({ type: "ready" });
paletteReceive?.({ type: "start" });
for (let i = 0; captureSources.length < 2 && i < 20; i++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
if (JSON.stringify(captureSources) !== JSON.stringify(["both", "microphone"])) {
  throw new Error(`capture fallback did not retry microphone: ${JSON.stringify(captureSources)}`);
}
if (paletteMessages.some((message) => message.type === "error")) {
  throw new Error(`transient capture failure leaked as a final error: ${JSON.stringify(paletteMessages)}`);
}
if (!paletteMessages.some((message) => message.type === "notice" && message.message.includes("마이크 전용"))) {
  throw new Error("microphone fallback notice is missing");
}

console.log("✓ meeting assistant plugin contract and activation smoke passed");
