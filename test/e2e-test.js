// End to end: mock remote core <-> Bridge (link, tunnels, registrar) <-> Hub <-> real UC drivers
// (Node.js and Python fixtures built on the official integration libraries).
//
//   node test/e2e-test.js            (needs network for npm / pip the first time)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startHub } from "../hub/src/server.js";
import { LinkClient } from "../bridge/src/bin/link.js";
import { Tunnels } from "../bridge/src/bin/tunnels.js";
import { Registrar } from "../bridge/src/bin/registrar.js";
import { CoreClient } from "../bridge/src/bin/core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 120000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const step = (s) => console.log(`\n▶ ${s}`);

// --- a client that speaks the Integration API like the remote's core ------------------------------
function coreSession(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    let id = 0;
    const waiting = new Map();
    const events = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.kind === "resp" && waiting.has(m.req_id)) {
        waiting.get(m.req_id)(m);
        waiting.delete(m.req_id);
      } else if (m.kind === "event") events.push(m);
      else if (m.kind === "req") {
        // drivers ask the core questions too (driver -> core requests pass the tunnel as well)
        const data = m.msg === "get_supported_entity_types" ? ["button", "switch", "climate", "cover", "light", "media_player", "remote", "sensor", "select"] : {};
        ws.send(JSON.stringify({ kind: "resp", req_id: m.id, code: 200, msg: m.msg === "get_supported_entity_types" ? "supported_entity_types" : "result", msg_data: data }));
        events.push({ reverse: m.msg });
      }
    });
    ws.on("open", () =>
      resolve({
        ws,
        events,
        req: (msg, msg_data) =>
          new Promise((res, rej) => {
            const rid = ++id;
            waiting.set(rid, res);
            ws.send(JSON.stringify({ kind: "req", id: rid, msg, ...(msg_data ? { msg_data } : {}) }));
            setTimeout(() => waiting.has(rid) && rej(new Error(`${msg} timed out`)), 10000);
          }),
        close: () => ws.close()
      })
    );
    ws.on("error", reject);
  });
}

// --- mock of the remote's core REST API (only what the bridge uses) ---------------------------------
function mockCore() {
  const drivers = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    calls.push(`${req.method} ${url.pathname}`);
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    if (req.headers.authorization !== "Bearer test-key") return send(401, { message: "no" });
    const m = /^\/api\/intg\/drivers(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return send(404, { message: "nope" });
    const id = m[1] && decodeURIComponent(m[1]);
    if (req.method === "GET" && !id) return send(200, [...drivers.values()]);
    if (req.method === "GET") return drivers.has(id) ? send(200, drivers.get(id)) : send(404, { message: "not found" });
    if (req.method === "POST" && !id) {
      const b = JSON.parse(body);
      // the real remote refuses a registration without these
      for (const f of ["driver_url", "name", "version"]) if (!b[f]) return send(400, { message: `Missing field: ${f}` });
      // like the real core: contact the driver and fetch its metadata before accepting it
      try {
        const s = await coreSession(b.driver_url);
        const r = await s.req("get_driver_metadata");
        s.close();
        drivers.set(b.driver_id, { ...b, driver_type: "EXTERNAL", metadata: r.msg_data });
        return send(201, drivers.get(b.driver_id));
      } catch (e) {
        return send(503, { message: e.message });
      }
    }
    if (req.method === "PATCH" && id) {
      Object.assign(drivers.get(id), JSON.parse(body));
      return send(200, drivers.get(id));
    }
    if (req.method === "DELETE" && id) {
      drivers.delete(id);
      return send(200, {});
    }
    send(404, { message: "nope" });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, drivers, calls, port: server.address().port })));
}

// --- the bridge, wired as in bridge/src/bin/driver.js -------------------------------------------------
function startBridge({ hubPort, token, corePort, state = {} }) {
  const logs = [];
  const log = (...a) => logs.push(a.join(" "));
  const link = new LinkClient({ hub: `127.0.0.1:${hubPort}`, token, remote: "test-remote", version: "test", log });
  const tunnels = new Tunnels({ link, log });
  const core = new CoreClient(`127.0.0.1:${corePort}`, { apiKey: "test-key" });
  const registrar = new Registrar({ getCore: () => core, tunnels, state, save: () => {}, log, onChange: (registered) => link.report({ registered }) });
  link.on("state", (s) => (s === "up" ? link.report({ registered: registrar.mapping() }) : tunnels.dropAll()));
  link.on("catalog", (d, r) => registrar.sync(d, r));
  link.start();
  return { link, tunnels, registrar, state, logs, stop: async () => (link.stop(), tunnels.closeAll()) };
}

// ------------------------------------------------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pegasis-e2e-"));
process.env.PEGASUS_ALLOW_LOCAL = "1";
const hub = await startHub({ port: 0, dataDir, quiet: true });
const core = await mockCore();
let bridge;
let failed = false;

try {
  step("install the Node.js and Python fixture drivers on the hub");
  for (const fx of ["sim-node", "sim-python"]) {
    const job = hub.mgr.install({ local: path.join(HERE, "fixtures", fx) });
    await until(() => job.state !== "running", 300000, `${fx} install`);
    if (job.state !== "done") {
      console.log(job.lines.join("\n"));
      throw new Error(`${fx} install failed: ${job.error}`);
    }
    console.log(`  ${fx}: ${hub.store.get(job.result.id).command.join(" ")}`);
  }
  await until(() => ["sim_node", "sim_python"].every((id) => hub.sup.info(id).state === "running"), 60000, "drivers running");
  console.log("  both drivers running");

  step("wrong pairing code is refused");
  {
    const bad = new LinkClient({ hub: `127.0.0.1:${hub.port}`, token: "wrong-code", remote: "x", version: "t" });
    const st = await new Promise((r) => {
      bad.on("state", (s) => (s === "denied" || s === "up") && r(s));
      bad.start();
    });
    bad.stop();
    assert.equal(st, "denied");
  }

  step("bridge links up and registers both drivers with the core");
  bridge = startBridge({ hubPort: hub.port, token: hub.store.hub.token, corePort: core.port });
  await until(() => core.drivers.has("sim_node") && core.drivers.has("sim_python"), 30000, "registration");
  const dn = core.drivers.get("sim_node");
  const dp = core.drivers.get("sim_python");
  assert.ok(![...core.drivers.keys()].some((k) => k.startsWith("pgs_")), "registered under a pgs_ ID");
  assert.match(dn.driver_url, /^ws:\/\/127\.0\.0\.1:97\d\d$/);
  assert.equal(dn.metadata.driver_id, "sim_node");
  assert.equal(dn.version, "1.0.0");
  assert.ok(dn.setup_data_schema && dn.description, "registered without the driver's details");
  assert.equal(dp.metadata.driver_id, "sim_python");
  console.log(`  sim_node   -> ${dn.driver_url}  (metadata name: ${dn.metadata.name.en})`);
  console.log(`  sim_python -> ${dp.driver_url}  (metadata name: ${dp.metadata.name.en})`);
  await until(() => hub.link.shownAs("sim_node")[0]?.id === "sim_node", 5000, "hub learns the remote ID");
  console.log(`  hub page: ${JSON.stringify(hub.link.shownAs("sim_node"))}`);

  step("the Bridge's problems and log reach the hub page");
  bridge.link.report({ registered: { sim_node: "sim_node", sim_python: "sim_python" }, problems: { other: "no access" }, access: true, log: ["hello from the bridge"] });
  await until(() => hub.link.bridgeLog("test-remote")?.includes("hello from the bridge"), 3000, "bridge log on hub");
  assert.equal(hub.link.status()[0].problems.other, "no access");
  console.log("  bridge log and problems shown on the hub");

  step("the core talks to the hosted Node driver through the tunnel");
  const s = await coreSession(dn.driver_url);
  const ents = await s.req("get_available_entities");
  assert.equal(ents.code, 200);
  assert.ok(ents.msg_data.available_entities.some((e) => e.entity_id === "sim_switch"));
  await s.req("subscribe_events", { entity_ids: ["sim_switch"] });
  const cmd = await s.req("entity_command", { entity_type: "switch", entity_id: "sim_switch", cmd_id: "toggle" });
  assert.equal(cmd.code, 200);
  const ev = await until(() => s.events.find((e) => e.msg === "entity_change" && e.msg_data.entity_id === "sim_switch"), 5000, "entity_change");
  assert.equal(ev.msg_data.attributes.state, "ON");
  console.log("  entities, command and entity_change event all passed through");
  {
    const net = await (await fetch(`http://127.0.0.1:${hub.server.address().port}/api/network`)).json();
    const r = net.remotes[0];
    const sim = net.integrations.find((x) => x.id === "sim_node");
    assert.ok(r && r.connected && r.totals.bytesIn > 0 && r.totals.bytesOut > 0, "remote traffic counted");
    assert.ok(sim && sim.requests >= 3 && sim.response.n >= 3 && sim.events >= 1, "driver requests timed");
    console.log(`  network stats: ${sim.requests} requests timed (median ${sim.response.median.toFixed(1)} ms), ${r.totals.msgsIn + r.totals.msgsOut} link frames`);
  }

  step("the core talks to the hosted Python driver through the tunnel");
  {
    const sp = await coreSession(dp.driver_url);
    const e2 = await sp.req("get_available_entities");
    assert.ok(e2.msg_data.available_entities.some((e) => e.entity_id === "sim_button"));
    assert.ok(sp.events.some((e) => e.reverse === "get_supported_entity_types"), "driver -> core request passed through");
    await sp.req("subscribe_events", { entity_ids: ["sim_button"] });
    const c2 = await sp.req("entity_command", { entity_type: "button", entity_id: "sim_button", cmd_id: "push" });
    assert.equal(c2.code, 200);
    sp.close();
    console.log("  entities, driver->core request and command passed through");
  }

  step("latency: tunnel vs. talking to the driver directly");
  {
    const N = 1000;
    const direct = await coreSession(`ws://127.0.0.1:${hub.store.get("sim_node").port}`);
    const time = async (sess) => {
      for (let i = 0; i < 50; i++) await sess.req("get_driver_version");
      const t = performance.now();
      for (let i = 0; i < N; i++) await sess.req("get_driver_version");
      return (performance.now() - t) / N;
    };
    const tDirect = await time(direct);
    const tTunnel = await time(s);
    direct.close();
    console.log(`  direct ${(tDirect * 1000).toFixed(0)} µs / request, through bridge+link+hub ${(tTunnel * 1000).toFixed(0)} µs / request (+${((tTunnel - tDirect) * 1000).toFixed(0)} µs)`);
    // big message (e.g. a long entity list) passes intact
    const big = await s.req("get_available_entities");
    assert.equal(big.code, 200);
  }

  step("driver restart: session is closed, the core reconnects, it works again");
  {
    const closed = new Promise((r) => s.ws.once("close", (code) => r(code)));
    hub.link.dropDriver("sim_node");
    await hub.sup.restart("sim_node");
    const code = await closed;
    console.log(`  core session closed with ${code}`);
    await until(() => hub.sup.info("sim_node").state === "running", 30000, "restart");
    const s2 = await coreSession(dn.driver_url);
    assert.equal((await s2.req("get_driver_version")).code, 200);
    s2.close();
    console.log("  reconnected ok");
  }

  step("hub goes away: core connections are refused politely, then recover");
  {
    const st = bridge.link;
    hub.link.disconnectAll();
    await until(() => st.state !== "up", 5000, "link down");
    const r = await new Promise((resolve) => {
      const w = new WebSocket(dn.driver_url);
      w.on("close", (code) => resolve(code));
      w.on("error", () => {});
    });
    assert.equal(r, 1013);
    console.log(`  while down: core connection closed with 1013 (try again later)`);
    await until(() => st.state === "up", 15000, "link back up");
    const s3 = await coreSession(dn.driver_url);
    assert.equal((await s3.req("get_driver_version")).code, 200);
    s3.close();
    console.log("  link back up, driver reachable again");
  }

  step("standby: check-ins pause, wake checks the link at once");
  {
    const L = bridge.link;
    L.setStandby(true);
    await until(() => hub.link.status()[0]?.standby === true, 3000, "hub sees standby");
    const hubLink = [...hub.link.links][0];
    const hubPing0 = hubLink.lastPing || 0, brPing0 = L.lastPing;
    await sleep(6500);
    assert.equal(hubLink.lastPing || 0, hubPing0, "hub pinged a sleeping remote");
    assert.equal(L.lastPing, brPing0, "bridge pinged while asleep");
    console.log("  no check-ins for 6.5 s while asleep");
    const t0 = Date.now();
    L.setStandby(false);
    await until(() => L.lastHeard >= t0 && hub.link.status()[0]?.standby === false, 2000, "wake check");
    console.log(`  awake: link confirmed in ${Date.now() - t0} ms`);
  }

  step("artwork: a picture link from the integration reaches the remote as a hub link, scaled down");
  {
    const { createRequire } = await import("node:module");
    const sharp = createRequire(import.meta.url)("../hub/node_modules/sharp");
    const poster = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: "#225588" } }).jpeg({ quality: 95 }).toBuffer();
    const imgSrv = http.createServer((q, r) => r.writeHead(200, { "Content-Type": "image/jpeg" }).end(poster));
    await new Promise((r) => imgSrv.listen(0, "127.0.0.1", r));
    await hub.mgr.setOptions("sim_node", { env: { SIM_IMAGE_URL: `http://127.0.0.1:${imgSrv.address().port}/poster.jpg` } });
    await hub.sup.restart("sim_node");
    await until(() => hub.sup.info("sim_node").state === "running", 20000, "restart");
    const sa = await until(async () => { try { return await coreSession(dn.driver_url); } catch { return null; } }, 15000, "session");
    await sa.req("subscribe_events", { entity_ids: ["sim_switch"] });
    await sa.req("entity_command", { entity_type: "switch", entity_id: "sim_switch", cmd_id: "toggle" });
    const ev = await until(() => sa.events.find((e) => e.msg === "entity_change" && e.msg_data.attributes?.media_image_url), 5000, "picture update");
    const link = ev.msg_data.attributes.media_image_url;
    assert.ok(link.startsWith(`http://127.0.0.1:${hub.port}/img/`), `not a hub link: ${link}`);
    const img = Buffer.from(await (await fetch(link)).arrayBuffer());
    const meta = await sharp(img).metadata();
    assert.deepEqual([meta.width, meta.height], [480, 720]);
    console.log(`  the remote got ${link.slice(0, 40)}…: 480×720, ${Math.round(img.length / 1024)} KB instead of ${Math.round(poster.length / 1024)} KB`);
    sa.close();
    imgSrv.close();
    await hub.mgr.setOptions("sim_node", { env: {} });
    await hub.sup.restart("sim_node");
    await until(() => hub.sup.info("sim_node").state === "running", 20000, "restart");
  }

  step("asleep: answers go at once, state updates are held and merged, delivered on wake");
  {
    const L = bridge.link;
    const sh = await coreSession(dn.driver_url);
    await sh.req("subscribe_events", { entity_ids: ["sim_switch"] });
    L.setStandby(true);
    await until(() => hub.link.status()[0]?.standby === true, 3000, "hub sees standby");
    const n0 = sh.events.filter((e) => e.msg === "entity_change").length;
    for (let i = 0; i < 3; i++) assert.equal((await sh.req("entity_command", { entity_type: "switch", entity_id: "sim_switch", cmd_id: "toggle" })).code, 200, "answer while asleep");
    await sleep(600);
    assert.equal(sh.events.filter((e) => e.msg === "entity_change").length, n0, "updates reached a sleeping remote");
    L.setStandby(false);
    const got = await until(() => { const ev = sh.events.filter((e) => e.msg === "entity_change"); return ev.length > n0 ? ev.slice(n0) : null; }, 3000, "held update on wake");
    await sleep(300);
    assert.equal(sh.events.filter((e) => e.msg === "entity_change").length - n0, 1, "one merged update expected");
    const states = await sh.req("get_entity_states");
    const real = states.msg_data.find((x) => x.entity_id === "sim_switch")?.attributes?.state;
    assert.equal(got[0].msg_data.attributes.state, real, "the delivered update must be the final state");
    const net = await (await fetch(`http://127.0.0.1:${hub.server.address().port}/api/network`)).json();
    const shaped = net.integrations.find((x) => x.id === "sim_node").shaped;
    assert.ok(shaped.held >= 1 && shaped.merged >= 2, JSON.stringify(shaped));
    console.log(`  3 commands answered while asleep; 3 updates held and delivered as 1 on wake (state ${got[0].msg_data.attributes.state})`);
    sh.close();
  }

  step("wake with a link that died during sleep: replaced within about a second");
  {
    const L = bridge.link;
    L.setStandby(true);
    await sleep(200);
    const deadWs = L.ws;
    // simulate a half-open connection: the hub side goes silent but TCP stays up
    for (const l of hub.link.links) l.ws.removeAllListeners("message");
    const t0 = Date.now();
    L.setStandby(false);
    await until(() => L.up && L.ws !== deadWs, 6000, "fresh link after wake");
    console.log(`  new link up ${Date.now() - t0} ms after wake`);
    const s4 = await coreSession(dn.driver_url);
    assert.equal((await s4.req("get_driver_version")).code, 200);
    s4.close();
  }

  step("a stopped driver stays registered on the remote");
  await hub.sup.stop("sim_python");
  await sleep(600);
  assert.ok(core.drivers.has("sim_python"));
  console.log("  still registered");

  step("uninstalling on the hub removes it from the remote");
  await hub.mgr.remove("sim_python");
  await until(() => !core.drivers.has("sim_python"), 10000, "driver removal");
  assert.ok(core.drivers.has("sim_node"));
  console.log("  sim_python removed, sim_node kept");

  console.log("\nE2E: all passed");
} catch (e) {
  failed = true;
  console.error("\nE2E FAILED:", e.stack || e.message);
  if (bridge) console.error("bridge log:\n  " + bridge.logs.join("\n  "));
  for (const id of ["sim_node", "sim_python"]) console.error(`${id} log:\n  ` + hub.sup.logs(id).slice(-15).join("\n  "));
} finally {
  await bridge?.stop();
  await hub.stop();
  core.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
