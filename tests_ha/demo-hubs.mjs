// Two demo hubs for the Home Assistant tests: 9611 with the sample integrations, a linked fake
// remote (with traffic and 6 days of battery readings around a first move), and 9612 with a page
// password. Run: node tests_ha/demo-hubs.mjs, wait for "ready", then pytest.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { startHub } = await import(path.join(ROOT, "hub/src/server.js"));
const P = await import(path.join(ROOT, "hub/src/linkproto.js"));
const { WebSocket } = await import(path.join(ROOT, "hub/node_modules/ws/wrapper.mjs"));

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));
const hub = await startHub({ port: 9611, dataDir: tmp("pg-ha-"), quiet: true, fetchRemoteStatus: async () => ({ memory: { total_memory: 3800 * 1048576, used_memory: 1500 * 1048576 }, load_avg: { one: 0.8, five: 0.9, fifteen: 1 }, filesystem: { user_data: { available: 2e9 } } }) });
await startHub({ port: 9612, dataDir: tmp("pg-ha-pw-"), password: "s3cret", quiet: true });
for (const fx of ["sim-node", "sim-python"]) {
  const job = hub.mgr.install({ local: path.join(ROOT, "test/fixtures", fx) });
  while (job.state === "running") await new Promise((r) => setTimeout(r, 300));
  if (job.state !== "done") throw new Error(`${fx}: ${job.error}`);
}
await new Promise((r) => setTimeout(r, 3000));

// a fake remote linked to the first hub
const name = "Remote3-demo.local";
const ws = new WebSocket("ws://127.0.0.1:9611/link");
await new Promise((r) => ws.on("open", r));
ws.send(P.json(P.T.HELLO, { proto: 1, token: hub.store.hub.token, bridge: "0.4.0", remote: name }));
ws.on("message", (d) => {
  const f = P.decode(d);
  if (f.type === P.T.RPC) { const m = P.parseJson(f.payload); ws.send(P.encode(P.T.RPC_RESULT, 0, JSON.stringify({ id: m.id, result: [] }))); }
  if (f.type === P.T.PING) ws.send(P.encode(P.T.PONG, 0, f.payload));
});
const now = Date.now();
const split = now - 3 * 864e5;
ws.send(P.json(P.T.STATUS, { standby: false, registered: Object.fromEntries(hub.store.list().map((m) => [m.id, m.id])), access: true, moves: { lmserver: { dir: "toHub", status: "done", step: "done", started: split, updated: split + 30000, log: [] } } }));
setInterval(() => ws.send(P.encode(P.T.PING, 0, P.pingPayload())), 2000);
// battery: 7 days, awake 7 h a day; 2.2 / 0.45 %/h before the move, 1.7 / 0.3 after
const bs = [];
for (let d = 6; d >= 0; d--) {
  const t0 = now - d * 864e5 - 20 * 3600e3, after = t0 > split, aw = after ? 1.7 : 2.2, as = after ? 0.3 : 0.45;
  for (let h = 0; h <= 7; h++) if (t0 + h * 3600e3 < now) bs.push({ t: t0 + h * 3600e3, level: Math.round(96 - aw * h), event: h === 7 ? "standby" : "periodic", charging: false });
  const wake = t0 + 24 * 3600e3 - 60000;
  if (wake < now) bs.push({ t: wake, level: Math.round(96 - aw * 7 - as * 17), event: "wake", charging: false }, { t: wake + 30000, level: 96, event: "periodic", charging: true });
}
hub.battery.add(name, bs);
// the hub reads a newly linked remote's status within about 10 s
await new Promise((r) => setTimeout(r, 12000));
console.log("ready");
