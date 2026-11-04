// Pegasus stand-in: installed by the Pegasus Bridge over an integration that is moving to the hub
// (the remote's "update existing driver" install, so it keeps the integration's ID, name, version
// and config files). It does two things:
//   1. hands the integration's config and data files to the Bridge (which sends them to the hub);
//   2. passes every connection from the remote's core through to the integration's copy on the hub
//      (via the Bridge's endpoint), so the integration keeps working during the move.
// It never changes the files it reads.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "standin.json"), "utf8")); // { driverId, control, token }
const log = (...a) => console.log(`[pegasis stand-in ${cfg.driverId}]`, ...a);
const MAX_BYTES = 50 * 1024 * 1024;

function readTree(root) {
  const out = [];
  let total = 0;
  if (!root || !fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        total += buf.length;
        if (total > MAX_BYTES) throw new Error("settings larger than 50 MB");
        out.push({ path: path.relative(root, p).split(path.sep).join("/"), b64: buf.toString("base64") });
      }
    }
  };
  walk(root);
  return out;
}

async function control(method, route, body) {
  const res = await fetch(`${cfg.control}${route}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Pegasus-Token": cfg.token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Bridge answered ${res.status}`);
  return res.json();
}

// 1. settings to the Bridge (retried until the Bridge takes them)
async function handOver() {
  const configDir = process.env.UC_CONFIG_HOME || process.env.HOME;
  const dataDir = process.env.UC_DATA_HOME || process.env.STATE_DIRECTORY;
  for (let attempt = 0; ; attempt++) {
    try {
      const files = { config: readTree(configDir), data: dataDir && dataDir !== configDir ? readTree(dataDir) : [] };
      await control("POST", `/standin/${encodeURIComponent(cfg.driverId)}/settings`, files);
      log(`settings handed over (${files.config.length} config, ${files.data.length} data files)`);
      return;
    } catch (e) {
      if (attempt % 10 === 0) log(`waiting for the Pegasus Bridge: ${e.message}`);
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * (attempt + 1))));
    }
  }
}

// 2. connections from the core, passed through to the hub copy
const wss = new WebSocketServer({
  host: process.env.UC_INTEGRATION_INTERFACE || undefined,
  port: Number(process.env.UC_INTEGRATION_HTTP_PORT || 9090),
  perMessageDeflate: false,
  maxPayload: 64 * 1024 * 1024
});
wss.on("connection", async (core) => {
  core._socket?.setNoDelay?.(true);
  // listen at once: the core sends its first request right after connecting, before the hub copy's
  // endpoint is known; everything is queued until that connection is up
  const queue = [];
  let target = null;
  let closed = false;
  const end = (code) => {
    if (closed) return;
    closed = true;
    if (core.readyState <= 1) core.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
    if (target && target.readyState <= 1) target.close();
  };
  core.on("message", (d, b) => (target?.readyState === 1 ? target.send(d, { binary: b }) : queue.push([d, b])));
  core.on("close", () => end(1000));
  core.on("error", () => end(1000));
  try {
    const { port } = await control("GET", `/standin/${encodeURIComponent(cfg.driverId)}/endpoint`);
    if (closed) return;
    target = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  } catch (e) {
    log(`hub copy not reachable yet: ${e.message}`);
    return end(1013);
  }
  target.on("open", () => {
    target._socket?.setNoDelay?.(true);
    for (const [d, b] of queue) target.send(d, { binary: b });
    queue.length = 0;
  });
  target.on("message", (d, b) => core.readyState === 1 && core.send(d, { binary: b }));
  target.on("close", (code) => end(code));
  target.on("error", () => end(1013));
});
wss.on("listening", () => log(`listening on ${wss.address().port}`));

handOver();
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => process.exit(0));
