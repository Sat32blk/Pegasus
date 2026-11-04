// Pegasus Bridge: a custom integration that runs on the Unfolded Circle Remote 3 / Remote Two.
//
// It keeps one fast, multiplexed link to a Pegasus Hub (a Docker container that hosts integration
// drivers) and makes every driver on the hub show up on the remote as its own integration:
//   - each hosted driver gets a loopback endpoint ws://127.0.0.1:<port> on the remote
//   - the bridge registers it with the remote's core as an external driver at that endpoint
//   - the core talks to it as to any driver; the bridge splices that WebSocket onto the link
// Setup flows, entities, commands, events and voice audio pass through byte for byte.

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as uc from "@unfoldedcircle/integration-api";
import { CoreClient } from "./core.js";
import { LinkClient } from "./link.js";
import { Tunnels } from "./tunnels.js";
import { Registrar } from "./registrar.js";
import { BatteryTracker } from "./battery.js";
import { Mover } from "./mover.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_JSON = fs.existsSync(path.join(HERE, "driver.json")) ? path.join(HERE, "driver.json") : path.join(HERE, "..", "driver.json");
const VERSION = JSON.parse(fs.readFileSync(DRIVER_JSON, "utf8")).version;

// Recent log lines are also sent to the hub (shown on its page), because reading the remote's own
// log needs the web-configurator login.
const recentLog = [];
const log = (...a) => {
  console.log("[pegasus]", ...a);
  recentLog.push(`${new Date().toISOString().slice(5, 19).replace("T", " ")} ${a.join(" ")}`);
  if (recentLog.length > 150) recentLog.splice(0, recentLog.length - 150);
  scheduleReport();
};

/** Tells the hub how things stand on this remote: IDs, problems, notes, recent log and battery. */
let reportTimer = null;
let resendBattery = true; // after (re)connecting, send the last 2 days again (the hub ignores duplicates)
function scheduleReport() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    if (!link?.up || !registrar) return;
    const s = registrar.summary();
    const batt = battery ? battery.pending(resendBattery) : [];
    link.report({
      battery: batt,
      registered: registrar.mapping(),
      problems: Object.fromEntries(s.problems),
      notes: Object.fromEntries(s.notes),
      access: !!config?.apiKey,
      moves: mover ? mover.summary() : {},
      log: recentLog.slice(-150)
    });
    battery?.markSent(batt);
    resendBattery = false;
  }, 500);
}

const api = new uc.IntegrationAPI();
let cfgFile;
let config = null; // { hub, token, apiKey, address, removeOnUninstall, state: { hosted: { <hubId>: { remoteId, port } } } }
let core = null;
let link = null;
let tunnels = null;
let registrar = null;
let battery = null;
let mover = null;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch {
    return null;
  }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  const tmp = cfgFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, cfgFile);
}

// ---------------------------------------------------------------------------
// Entities: link status + latency (handy on a page while setting things up)
// ---------------------------------------------------------------------------

const statusSensor = new uc.Sensor("pegasus_link", { en: "Pegasus Hub link" }, {
  area: "Pegasus",
  attributes: { state: uc.SensorStates.On, value: "not set up" }
});
const latencySensor = new uc.Sensor("pegasus_latency", { en: "Pegasus Hub latency" }, {
  area: "Pegasus",
  deviceClass: uc.SensorDeviceClasses.Custom,
  options: { custom_unit: "ms", decimals: 1 },
  attributes: { state: uc.SensorStates.Unavailable, value: 0, unit: "ms" }
});
const resyncButton = new uc.Button("pegasus_resync", { en: "Pegasus: re-sync integrations" }, {
  area: "Pegasus",
  cmdHandler: async () => {
    registrar?.resync();
    return uc.StatusCodes.Ok;
  }
});

function publish(entity, attrs) {
  if (!api.updateEntityAttributes(entity.id, attrs)) Object.assign(entity.attributes, attrs);
}

function statusText() {
  if (!config) return "not set up";
  if (!link) return "starting";
  const s = registrar?.summary();
  switch (link.state) {
    case "up": {
      const n = s ? `${s.onRemote}/${s.hosted} integrations` : "";
      const p = s?.problems.length ? ` · ${s.problems.length} waiting` : "";
      return `Linked · ${link.rttMs != null ? link.rttMs.toFixed(1) + " ms" : "…"} · ${n}${p}`;
    }
    case "denied":
      return "Pairing code refused: run setup again";
    case "connecting":
      return `Connecting to ${config.hub}…`;
    default:
      return `Hub offline (${link.reason || "not reachable"})`;
  }
}

let lastStatus = "";
function refreshStatus() {
  const v = statusText();
  if (v !== lastStatus) {
    lastStatus = v;
    publish(statusSensor, { state: uc.SensorStates.On, value: v });
  }
}

let lastRttPublished = 0;
function publishRtt(rtt) {
  if (Date.now() - lastRttPublished < 4000) return;
  lastRttPublished = Date.now();
  publish(latencySensor, { state: uc.SensorStates.On, value: Math.round(rtt * 10) / 10, unit: "ms" });
  refreshStatus();
}

// ---------------------------------------------------------------------------
// Link lifecycle
// ---------------------------------------------------------------------------

async function startLink() {
  await stopLink();
  if (!config?.hub || !config?.token) return;
  core = config.apiKey ? new CoreClient(config.address || "127.0.0.1", { apiKey: config.apiKey }) : null;
  config.state ||= {};
  link = new LinkClient({ hub: config.hub, token: config.token, remote: remoteName(), version: VERSION, log });
  tunnels = new Tunnels({ link, log });
  registrar = new Registrar({
    getCore: () => core,
    tunnels,
    state: config.state,
    save: saveConfig,
    log,
    removeOnUninstall: () => config.removeOnUninstall !== false,
    onChange: () => scheduleReport()
  });
  link.on("state", (state) => {
    if (state === "up") {
      resendBattery = true;
      scheduleReport();
      setTimeout(() => mover?.reconcile().catch((e) => log(`reconcile: ${e.message}`)), 3000);
    }
    if (state !== "up") {
      tunnels.dropAll();
      publish(latencySensor, { state: uc.SensorStates.Unavailable });
    }
    refreshStatus();
  });
  link.on("catalog", async (drivers, removed) => {
    log(`hub lists ${drivers.length} integration(s): ${drivers.map((d) => `${d.driver_id || d.id} (${d.state})`).join(", ") || "none"}`);
    await registrar.sync(drivers, removed);
    scheduleReport();
    refreshStatus();
  });
  link.on("rtt", publishRtt);
  mover = new Mover({
    getCore: () => core,
    link,
    registrar,
    tunnels,
    state: config.state,
    save: saveConfig,
    log,
    binDir: HERE,
    dir: path.join(api.getConfigDirPath(), "moves"),
    onChange: () => scheduleReport()
  });
  await mover.startControl().catch((e) => log(`move control endpoint: ${e.message}`));
  // requests from the hub page
  // with { hash } (hub 0.6+): answers { same: true } when nothing changed, so the list isn't resent
  link.handle("remote.integrations", async (params = {}) => {
    const list = await mover.integrations();
    if (params.hash === undefined) return list;
    const hash = crypto.createHash("sha1").update(JSON.stringify(list)).digest("hex").slice(0, 16);
    return params.hash === hash ? { same: true, hash } : { list, hash };
  });
  link.handle("move.toHub", ({ driverId, keepSlot }) => mover.toHub(String(driverId), { keepSlot: !!keepSlot }));
  link.handle("move.toRemote", ({ driverId }) => mover.toRemote(String(driverId)));
  link.handle("move.retry", ({ driverId, leaveOut }) => mover.retry(String(driverId), { leaveOut }));
  link.handle("move.status", () => mover.summary());
  await registrar.restore();
  link.start();
  battery?.start();
  refreshStatus();
}

async function stopLink() {
  battery?.stop();
  mover?.stopControl();
  link?.stop();
  link = null;
  await tunnels?.closeAll();
  tunnels = null;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setupPage(values = {}) {
  return [
    { id: "hub", label: { en: "Hub address (host or host:port, shown on the hub's page)" }, field: { text: { value: values.hub || "" } } },
    { id: "token", label: { en: "Pairing code (shown on the hub's page)" }, field: { text: { value: values.token || "" } } },
    {
      id: "pin",
      label: { en: config?.apiKey ? "Web-configurator PIN (leave empty to keep the current access)" : "Web-configurator PIN (used once to create an API key)" },
      field: { password: { value: "" } }
    },
    {
      id: "remove",
      label: { en: "Remove integrations from this remote when they are removed on the hub" },
      field: { checkbox: { value: values.removeOnUninstall !== false } }
    }
  ];
}

/** Tries the link with the given address and code. Resolves "up" | "denied" | "unreachable". */
function probeLink(hub, token) {
  return new Promise((resolve) => {
    const probe = new LinkClient({ hub, token, remote: `${remoteName()} (setup)`, version: VERSION });
    const done = (r) => {
      clearTimeout(t);
      probe.stop();
      resolve(r);
    };
    const t = setTimeout(() => done("unreachable"), 7000);
    probe.on("state", (s) => {
      if (s === "up") done("up");
      else if (s === "denied") done("denied");
    });
    probe.start();
  });
}

async function applySetup(v) {
  const hub = String(v.hub || "").trim();
  const token = String(v.token || "").trim();
  const pin = String(v.pin || "").trim();
  if (!hub || !token) return new uc.SetupError(uc.IntegrationSetupError.Other);

  const probe = await probeLink(hub, token);
  if (probe === "unreachable") {
    log(`setup: hub ${hub} not reachable`);
    return new uc.SetupError(uc.IntegrationSetupError.ConnectionRefused);
  }
  if (probe === "denied") {
    log("setup: the hub refused the pairing code");
    return new uc.SetupError(uc.IntegrationSetupError.AuthorizationError);
  }

  const address = config?.address || "127.0.0.1";
  let apiKey = config?.apiKey || null;
  if (pin) {
    const setupClient = new CoreClient(address, { pin });
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
      apiKey = await setupClient.createApiKey(`Pegasus Bridge ${stamp}`);
    } catch (e) {
      log("setup: creating the API key failed:", e.message);
      return new uc.SetupError(e.kind === "unauthorized" ? uc.IntegrationSetupError.AuthorizationError : uc.IntegrationSetupError.Other);
    }
  }
  if (!apiKey) {
    log("setup: no PIN entered and no API key stored");
    return new uc.SetupError(uc.IntegrationSetupError.AuthorizationError);
  }
  try {
    await new CoreClient(address, { apiKey }).get("/intg/drivers?limit=1");
  } catch (e) {
    log("setup: the API key does not work:", e.message);
    return new uc.SetupError(uc.IntegrationSetupError.AuthorizationError);
  }

  config = {
    ...(config || {}),
    hub,
    token,
    address,
    apiKey,
    removeOnUninstall: !(v.remove === "false" || v.remove === false),
    state: config?.state || {}
  };
  saveConfig();
  await startLink();
  log("setup complete");
  return new uc.SetupComplete();
}

async function setupHandler(msg) {
  if (msg instanceof uc.DriverSetupRequest) {
    if (msg.reconfigure || !msg.setupData?.hub) {
      return new uc.RequestUserInput({ en: "Connect to a Pegasus Hub" }, setupPage(config || {}));
    }
    return applySetup(msg.setupData);
  }
  if (msg instanceof uc.UserDataResponse) return applySetup(msg.inputValues);
  if (msg instanceof uc.AbortDriverSetup) log("setup aborted:", msg.error);
  return new uc.SetupError();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

api.on(uc.Events.Connect, async () => {
  await api.setDeviceState(config ? uc.DeviceStates.Connected : uc.DeviceStates.Disconnected);
  refreshStatus();
});
// The remote is going to sleep / waking up: slow the link's heartbeat down / check the link at once.
api.on(uc.Events.EnterStandby, async () => {
  await battery?.sample("standby"); // last reading before sleep (sent to the hub after waking)
  battery?.stop();
  link?.setStandby(true);
});
api.on(uc.Events.ExitStandby, async () => {
  link?.setStandby(false);
  battery?.start(); // first reading after waking
});

api.on(uc.Events.SubscribeEntities, async () => {
  lastStatus = "";
  refreshStatus();
});

for (const e of [statusSensor, latencySensor, resyncButton]) api.addAvailableEntity(e);
api.init(DRIVER_JSON, setupHandler);
cfgFile = path.join(api.getConfigDirPath(), "pegasus_bridge.json");
config = loadConfig();
battery = new BatteryTracker({
  getCore: () => core,
  file: path.join(api.getConfigDirPath(), "battery.json"),
  log,
  onSample: () => scheduleReport()
});
if (config) {
  log(`starting: hub ${config.hub}`);
  startLink().catch((e) => log("start failed:", e.message));
} else {
  log("not configured yet: run the integration setup");
}
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, async () => {
  await stopLink();
  process.exit(0);
});

/** The remote's name without ".local" (its host name sometimes has it, sometimes not). */
function remoteName() {
  return os.hostname().replace(/\.local\.?$/i, "").replace(/\.$/, "") || "remote";
}
