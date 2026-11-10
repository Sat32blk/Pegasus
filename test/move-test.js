// Moving an installed integration from the remote to the hub and back, end to end:
// stand-in remote (test/mock-remote.js) ⇄ Bridge (link, tunnels, registrar, mover) ⇄ hub ⇄ the
// integration running for real (the Node.js test driver), with its settings and every reference
// to its entities checked after each move.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startHub } from "../hub/src/server.js";
import { LinkClient } from "../bridge/src/bin/link.js";
import { Tunnels } from "../bridge/src/bin/tunnels.js";
import { Registrar } from "../bridge/src/bin/registrar.js";
import { Mover } from "../bridge/src/bin/mover.js";
import { CoreClient } from "../bridge/src/bin/core.js";
import { createTarGz } from "../bridge/src/bin/tar.js";
import { run } from "../hub/src/util.js";
import { startMockRemote } from "./mock-remote.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bridge", "src", "bin");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n▶ ${s}`);
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(200);
  }
}

// ---- the integration as it would be released for the remote: driver.json + bin/ (with node_modules)
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pg-move-"));
const fixture = path.join(HERE, "fixtures", "sim-node");
const build = path.join(work, "build");
fs.cpSync(fixture, build, { recursive: true });
await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: build, log: () => {} });
const driverJson = { ...JSON.parse(fs.readFileSync(path.join(fixture, "driver.json"))), home_page: "https://github.com/example/uc-intg-sim-node" };
const entries = [
  { name: "driver.json", data: JSON.stringify(driverJson) },
  { name: "bin/driver.json", data: JSON.stringify(driverJson) },
  { name: "config/settings.json", data: JSON.stringify({ token: "keep-me", devices: ["lamp"] }) }
];
const walk = (dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "driver.json" && rel === "bin") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
    else entries.push({ name: `${rel}/${e.name}`, data: fs.readFileSync(p) });
  }
};
walk(build, "bin");
const releaseArchive = createTarGz(entries);

// ---- remote, hub, bridge
const remote = await startMockRemote({ log: process.env.DEBUG ? console.log : () => {} });
const hub = await startHub({
  port: 0,
  dataDir: path.join(work, "hub"),
  quiet: true,
  moveSources: {
    prepare: async () => ({ local: fixture }),
    release: async (_m, file) => fs.writeFileSync(file, releaseArchive)
  }
});
const logs = [];
const log = (...a) => logs.push(a.join(" "));
const state = {};
const core = new CoreClient(`127.0.0.1:${remote.port}`, { apiKey: "test-key" });
const link = new LinkClient({ hub: `127.0.0.1:${hub.port}`, token: hub.store.hub.token, remote: "test-remote", version: "test", log });
const tunnels = new Tunnels({ link, log });
const registrar = new Registrar({ getCore: () => core, tunnels, state, save: () => {}, log, onChange: (registered) => link.report({ registered }) });
const mover = new Mover({ getCore: () => core, link, registrar, tunnels, state, save: () => {}, log, binDir: BIN, dir: path.join(work, "moves") });
await mover.startControl();
link.handle("remote.integrations", () => mover.integrations());
link.handle("move.toHub", ({ driverId, keepSlot }) => mover.toHub(driverId, { keepSlot }));
link.handle("move.toRemote", ({ driverId }) => mover.toRemote(driverId));
link.handle("move.retry", ({ driverId, leaveOut }) => mover.retry(driverId, { leaveOut }));
link.on("state", (s) => s !== "up" && tunnels.dropAll());
link.on("catalog", (d, r) => registrar.sync(d, r));
link.start();
await until(() => link.up, 10000, "link up");

// what a move must preserve
const P = "sim_node.main.";
function setUpRemote() {
  remote.install(releaseArchive, false);
  remote.instances.set("sim_node.main", { integration_id: "sim_node.main", driver_id: "sim_node", name: { en: "Sim" }, enabled: true, configured: ["sim_switch"] });
  remote.entities.set(P + "sim_switch", { entity_id: P + "sim_switch", integration_id: "sim_node.main", name: { en: "Lamp" }, icon: "uc:lightbulb", entity_type: "switch" });
  remote.entities.set("other.main.tv", { entity_id: "other.main.tv", integration_id: "other.main", name: { en: "TV" } });
  remote.activities.set("act1", {
    entity_id: "act1",
    name: { en: "Evening" },
    options: {
      included_entities: [{ entity_id: P + "sim_switch" }, { entity_id: "other.main.tv" }],
      sequences: { on: [{ type: "command", command: { entity_id: "other.main.tv", cmd_id: "on" } }, { type: "delay", delay: 500 }, { type: "command", command: { entity_id: P + "sim_switch", cmd_id: "on" } }], off: [{ type: "command", command: { entity_id: P + "sim_switch", cmd_id: "off" } }] },
      button_mapping: [{ button: "POWER", short_press: { entity_id: P + "sim_switch", cmd_id: "toggle" } }, { button: "VOLUME_UP", short_press: { entity_id: "other.main.tv", cmd_id: "volume_up" } }],
      user_interface: { pages: [{ page_id: "pg1", name: "Main", grid: { width: 4, height: 6 }, items: [{ type: "text", text: "Lamp", command: { entity_id: P + "sim_switch", cmd_id: "toggle" }, location: { x: 0, y: 0 } }, { type: "text", text: "TV", command: { entity_id: "other.main.tv", cmd_id: "on" }, location: { x: 1, y: 0 } }] }] }
    }
  });
  remote.macros.set("m1", { entity_id: "m1", name: { en: "All off" }, options: { included_entities: [{ entity_id: P + "sim_switch" }], sequence: [{ type: "command", command: { entity_id: P + "sim_switch", cmd_id: "off" } }] } });
  remote.pages.set("p1", [{ page_id: "home1", profile_id: "p1", name: "Home", pos: 0, items: [{ entity_id: P + "sim_switch", pos: 0 }, { entity_id: "other.main.tv", pos: 1 }] }]);
  remote.groups.set("p1", [{ group_id: "g1", profile_id: "p1", name: "Lights", entities: [P + "sim_switch"] }]);
}
const view = () =>
  JSON.parse(
    JSON.stringify({
      act: remote.activities.get("act1").options,
      macro: remote.macros.get("m1").options,
      home: remote.pages.get("p1")[0].items.map(({ entity_id }) => entity_id),
      group: remote.groups.get("p1")[0].entities,
      name: remote.entities.get(P + "sim_switch")?.name,
      icon: remote.entities.get(P + "sim_switch")?.icon
    })
  );
async function waitMove(id) {
  const end = Date.now() + (Number(process.env.MOVE_WAIT_MS) || 240000);
  for (;;) {
    const m = mover.summary()[id];
    if (m && m.status !== "running") return m;
    if (Date.now() > end) throw new Error(`move did not finish: ${JSON.stringify(mover.summary()[id])}`);
    await sleep(300);
  }
}
async function coreAsk(url, msg, msg_data) {
  const ws = new WebSocket(url);
  try {
    await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
    return await new Promise((r, j) => {
      const t = setTimeout(() => j(new Error(`${msg}: no answer`)), 5000);
      ws.on("close", (code) => (clearTimeout(t), j(new Error(`closed ${code}`))));
      ws.on("message", (d) => {
        const m = JSON.parse(d);
        if (m.kind === "resp" && m.req_id === 1) (clearTimeout(t), r(m));
      });
      ws.send(JSON.stringify({ kind: "req", id: 1, msg, ...(msg_data ? { msg_data } : {}) }));
    });
  } finally {
    ws.close();
  }
}

let failed = false;
try {
  step("an integration installed on the remote, with settings, a renamed entity and uses everywhere");
  setUpRemote();
  const before = view();
  await until(async () => (await remote.drivers.get("sim_node")?.port) && fs.existsSync(path.join(remote.drivers.get("sim_node").dir, "config", "settings.json")), 10000, "installed");
  const list = await hub.link.call("test-remote", "remote.integrations", {}, 10000);
  const sim = list.find((i) => i.driver_id === "sim_node");
  assert.equal(sim.movable, true, `not movable: ${sim.why}`);
  console.log(`  listed on the hub as movable (${sim.name} ${sim.version})`);

  step("move to the hub");
  await hub.link.call("test-remote", "move.toHub", { driverId: "sim_node" }, 10000);
  const done = await waitMove("sim_node");
  console.log("  " + done.log.join("\n  "));
  assert.equal(done.status, "done", done.error);
  const d = remote.drivers.get("sim_node");
  assert.equal(d.type, "EXTERNAL", "not registered as external");
  assert.match(d.meta.driver_url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.equal([...remote.drivers.values()].filter((x) => x.type === "CUSTOM").length, 0, "slot not freed");
  assert.equal(hub.sup.info("sim_node").state, "running");
  const settings = JSON.parse(fs.readFileSync(path.join(hub.store.configDir("sim_node"), "settings.json"), "utf8"));
  assert.deepEqual(settings, { token: "keep-me", devices: ["lamp"] }, "settings didn't arrive on the hub");
  assert.deepEqual(view(), before, "references differ after the move");
  const ents = await coreAsk(d.meta.driver_url, "get_available_entities");
  assert.ok(ents.msg_data.available_entities.some((e) => e.entity_id === "sim_switch"));
  console.log("  slot freed, same ID, settings on the hub, every reference back, entity reachable through the link");

  step("move back to the remote");
  await hub.link.call("test-remote", "move.toRemote", { driverId: "sim_node" }, 10000);
  const back = await waitMove("sim_node");
  console.log("  " + back.log.join("\n  "));
  assert.equal(back.status, "done", back.error);
  assert.equal(remote.drivers.get("sim_node").type, "CUSTOM");
  const remoteSettings = JSON.parse(fs.readFileSync(path.join(remote.drivers.get("sim_node").dir, "config", "settings.json"), "utf8"));
  assert.deepEqual(remoteSettings, { token: "keep-me", devices: ["lamp"] }, "settings didn't come back");
  assert.deepEqual(view(), before, "references differ after moving back");
  assert.equal(hub.store.get("sim_node"), null, "still on the hub");
  console.log("  installed on the remote again with its settings, every reference back, gone from the hub");

  step("a failure while restoring stops the move, keeps the snapshot, and a retry finishes it");
  remote.failOnce((m, p) => m === "PATCH" && p.startsWith("/api/macros/"));
  await hub.link.call("test-remote", "move.toHub", { driverId: "sim_node" }, 10000);
  const broken = await waitMove("sim_node");
  assert.equal(broken.status, "failed");
  assert.equal(broken.canRetry, true);
  console.log(`  stopped at "${broken.step}": ${broken.error}`);
  await hub.link.call("test-remote", "move.retry", { driverId: "sim_node" }, 10000).catch(() => mover.retry("sim_node"));
  const fixed = await waitMove("sim_node");
  assert.equal(fixed.status, "done", fixed.error);
  assert.deepEqual(view(), before, "references differ after the retry");
  console.log("  retried: every reference back");

  step("keeping the slot: the stand-in passes the remote's traffic to the hub copy");
  await hub.link.call("test-remote", "move.toRemote", { driverId: "sim_node" }, 10000);
  assert.equal((await waitMove("sim_node")).status, "done");
  await hub.link.call("test-remote", "move.toHub", { driverId: "sim_node", keepSlot: true }, 10000);
  const kept = await waitMove("sim_node");
  assert.equal(kept.status, "done", kept.error);
  const sd = remote.drivers.get("sim_node");
  assert.equal(sd.type, "CUSTOM", "slot not kept");
  assert.ok(fs.existsSync(path.join(sd.dir, "bin", "standin.json")), "stand-in not installed");
  const viaStandIn = await until(async () => {
    try {
      return await coreAsk(`ws://127.0.0.1:${remote.drivers.get("sim_node").port}`, "get_available_entities");
    } catch (e) {
      if (process.env.DEBUG) console.log(`  (stand-in on ${remote.drivers.get("sim_node").port}: ${e.message})`);
      return null;
    }
  }, 10000, "stand-in answering");
  assert.ok(viaStandIn.msg_data.available_entities.some((e) => e.entity_id === "sim_switch"), "stand-in did not reach the hub copy");
  assert.deepEqual(view(), before, "references changed while keeping the slot");
  console.log("  the remote's connection to the stand-in reached the integration running on the hub");

  step("moving back from the stand-in brings the hub's current settings");
  fs.writeFileSync(path.join(hub.store.configDir("sim_node"), "settings.json"), JSON.stringify({ token: "changed-on-hub", devices: ["lamp"] }));
  await hub.link.call("test-remote", "move.toRemote", { driverId: "sim_node" }, 10000);
  const back2 = await waitMove("sim_node");
  assert.equal(back2.status, "done", back2.error);
  const d2 = remote.drivers.get("sim_node");
  assert.ok(!fs.existsSync(path.join(d2.dir, "bin", "standin.json")), "stand-in still installed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(d2.dir, "config", "settings.json"))).token, "changed-on-hub");
  assert.deepEqual(view(), before, "references differ after moving back from the stand-in");
  console.log("  the original is installed again with the hub's settings; every reference back");

  step("a move back saved by Bridge 0.3.3 (no entities in its snapshot) is finished by Retry");
  await hub.link.call("test-remote", "move.toHub", { driverId: "sim_node" }, 10000);
  assert.equal((await waitMove("sim_node")).status, "done");
  remote.failOnce((m, p) => m === "PATCH" && p.startsWith("/api/activities/"));
  await hub.link.call("test-remote", "move.toRemote", { driverId: "sim_node" }, 10000);
  const stuck = await waitMove("sim_node");
  assert.equal(stuck.status, "failed");
  // what 0.3.3 left behind: a snapshot with no entities, and an instance with none selected
  const snapFile = mover.state.moves.sim_node.snapshotFile;
  const oldSnap = JSON.parse(fs.readFileSync(snapFile, "utf8"));
  fs.writeFileSync(snapFile, JSON.stringify({ ...oldSnap, configured: [] }));
  const si = remote.instances.get("sim_node.main");
  si.configured = [];
  for (const k of [...remote.entities.keys()]) if (k.startsWith("sim_node.main.")) remote.entities.delete(k);
  mover.retry("sim_node");
  const healed = await waitMove("sim_node");
  console.log("  " + healed.log.slice(-4).join("\n  "));
  assert.equal(healed.status, "done", healed.error);
  assert.deepEqual(view(), before, "references differ after retrying the stuck move back");
  assert.equal(hub.store.get("sim_node"), null, "the retried move back left the hub copy behind");
  console.log("  the entities the saved activities use were selected again, and every reference is back");
  {
    const { entityIdsOf } = await import("../bridge/src/bin/remote.js");
    assert.deepEqual(entityIdsOf({ ...oldSnap, configured: [], entities: [] }), ["sim_switch"], "references alone name the entity");
    console.log("  even with no entity list at all, the saved references name every entity to select");
  }

  step("a finished move back that left the hub copy behind (Bridge 0.3.4 Retry) is cleaned up when the link comes up");
  {
    await hub.link.call("test-remote", "move.toHub", { driverId: "sim_node" }, 10000);
    assert.equal((await waitMove("sim_node")).status, "done");
    await hub.link.call("test-remote", "move.toRemote", { driverId: "sim_node" }, 10000);
    assert.equal((await waitMove("sim_node")).status, "done");
    // put a stopped hub copy back and mark the move the way 0.3.4 left it
    const mv = mover.state.moves.sim_node;
    const job = hub.mgr.install({ local: path.join(HERE, "fixtures", "sim-node"), hold: true, noStart: true });
    await until(() => job.state !== "running", 300000, "hub copy");
    mv.hubId = job.result.id;
    delete mv.hubCleaned;
    assert.ok(hub.store.get(mv.hubId), "hub copy present");
    await mover.reconcile();
    assert.equal(hub.store.get(mv.hubId), null, "hub copy not removed");
    assert.equal(remote.drivers.get("sim_node")?.type, "CUSTOM", "the remote's own copy must stay");
    assert.deepEqual(view(), before, "references changed by the cleanup");
    console.log("  hub copy removed; the integration on the remote and every reference untouched");
  }

  step("entities the integration stopped offering before the move are left out instead of stopping it");
  {
    if (remote.drivers.get("sim_node")?.type !== "CUSTOM") {
      await hub.link.call("test-remote", "move.toRemote", { driverId: "sim_node" }, 10000);
      assert.equal((await waitMove("sim_node")).status, "done");
    }
    const addGhost = (id) => {
      const inst = remote.instances.get("sim_node.main");
      if (!inst.configured.includes(id)) inst.configured.push(id);
      remote.entities.set(P + id, { entity_id: P + id, integration_id: "sim_node.main", name: { en: id }, entity_type: "sensor" });
      const a = remote.activities.get("act1").options;
      a.included_entities.push({ entity_id: P + id });
      a.sequences.on.push({ type: "command", command: { entity_id: P + id, cmd_id: "x" } });
      a.user_interface.pages[0].items.push({ type: "text", text: id, command: { entity_id: P + id, cmd_id: "x" }, location: { x: 2, y: 0 } });
    };
    const mentions = (id) => JSON.stringify(remote.activities.get("act1")).includes(P + id);
    addGhost("display_test");
    remote.notOffered.always.add("display_test");
    await hub.link.call("test-remote", "move.toHub", { driverId: "sim_node" }, 10000);
    const m1 = await waitMove("sim_node");
    assert.equal(m1.status, "done", m1.error);
    assert.ok(m1.log.some((l) => /left out display_test/.test(l)), "left-out entity not reported");
    assert.equal(mentions("display_test"), false, "the left-out entity is still used");
    assert.ok(remote.instances.get("sim_node.main").configured.includes("sim_switch"));
    assert.ok(mentions("sim_switch"), "the working entity lost its places");
    console.log("  display_test (not offered before the move) left out; sim_switch and its places back");

    step("an entity the hub copy doesn't offer stops the move; \"continue without it\" finishes it");
    await hub.link.call("test-remote", "move.toRemote", { driverId: "sim_node" }, 10000);
    assert.equal((await waitMove("sim_node")).status, "done");
    addGhost("slider_tv_volume");
    remote.notOffered.external.add("slider_tv_volume");
    await hub.link.call("test-remote", "move.toHub", { driverId: "sim_node" }, 10000);
    const m2 = await waitMove("sim_node");
    assert.equal(m2.status, "failed");
    assert.deepEqual(m2.missing, ["slider_tv_volume"]);
    console.log(`  stopped: ${m2.error}`);
    await hub.link.call("test-remote", "move.retry", { driverId: "sim_node", leaveOut: ["slider_tv_volume", "sim_switch"] }, 10000);
    const m3 = await waitMove("sim_node");
    assert.equal(m3.status, "done", m3.error);
    assert.equal(mentions("slider_tv_volume"), false);
    assert.ok(remote.instances.get("sim_node.main").configured.includes("sim_switch"), "an entity not in the failed list must not be dropped");
    assert.ok(mentions("sim_switch"));
    console.log("  continued without slider_tv_volume; only entities that failed can be left out");

    step("an entity that's selected but has no entity on the remote stops before the restore, with \"continue without it\"");
    await hub.link.call("test-remote", "move.toRemote", { driverId: "sim_node" }, 10000);
    assert.equal((await waitMove("sim_node")).status, "done");
    remote.notOffered.external.clear();
    addGhost("media_player.10.0.0.180");
    remote.notOffered.noEntity.add("media_player.10.0.0.180");
    await hub.link.call("test-remote", "move.toHub", { driverId: "sim_node" }, 10000);
    const m4 = await waitMove("sim_node");
    assert.equal(m4.status, "failed");
    assert.notEqual(m4.step, "restore", "it must stop before writing references back");
    assert.deepEqual(m4.missing, ["media_player.10.0.0.180"]);
    console.log(`  stopped: ${m4.error}`);
    await hub.link.call("test-remote", "move.retry", { driverId: "sim_node", leaveOut: ["media_player.10.0.0.180"] }, 10000);
    const m5 = await waitMove("sim_node");
    assert.equal(m5.status, "done", m5.error);
    assert.equal(mentions("media_player.10.0.0.180"), false);
    assert.ok(mentions("sim_switch"));
    remote.notOffered.noEntity.clear();
    console.log("  continued without it; the rest restored");
    remote.notOffered.always.clear();
    remote.notOffered.external.clear();
  }

  step("the Bridge itself can't move; Remote Self-Control can");
  const archiveAs = (id) => createTarGz(entries.map((e) => (e.name.endsWith("driver.json") ? { ...e, data: JSON.stringify({ ...driverJson, driver_id: id }) } : e)));
  remote.install(archiveAs("pegasus_bridge"), false);
  remote.install(archiveAs("self_control"), false);
  const all = await hub.link.call("test-remote", "remote.integrations", {}, 10000);
  const bridgeRow = all.find((i) => i.driver_id === "pegasus_bridge");
  assert.equal(bridgeRow.movable, false);
  assert.equal(all.find((i) => i.driver_id === "self_control").movable, true, "self_control should be movable now");
  await assert.rejects(hub.link.call("test-remote", "move.toHub", { driverId: "pegasus_bridge" }, 10000).then(() => waitMove("pegasus_bridge")).then((m) => { if (m.status !== "done") throw new Error(m.error); }), /Bridge itself/);
  console.log(`  pegasus_bridge: not movable (${bridgeRow.why}); self_control: movable`);

  step("an integration whose driver.json doesn't link GitHub is found in the integration catalog");
  {
    const { _setCatalog } = await import("../hub/src/catalog.js");
    const noGit = createTarGz(entries.map((e) => (e.name.endsWith("driver.json") ? { ...e, data: JSON.stringify({ ...driverJson, driver_id: "fyta_driver", home_page: "https://www.example.com", developer: { name: "x", url: "https://www.example.com" } }) } : e)));
    remote.install(noGit, false);
    _setCatalog({});
    let row = (await hub.link.call("test-remote", "remote.integrations", {}, 10000)).find((i) => i.driver_id === "fyta_driver");
    assert.equal(row.movable, false);
    assert.match(row.why, /catalog/);
    _setCatalog({ fyta_driver: "https://github.com/example/uc-intg-fyta" });
    row = (await hub.link.call("test-remote", "remote.integrations", {}, 10000)).find((i) => i.driver_id === "fyta_driver");
    assert.equal(row.movable, true, row.why);
    assert.equal(row.home_page, "https://github.com/example/uc-intg-fyta");
    console.log("  not movable without a repository; movable once the catalog names one");
  }

  step("settings that point at the remote itself are switched to its address on the hub, and back");
  {
    const { pointSettings } = await import("../hub/src/moves.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-point-"));
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ address: "127.0.0.1", apiKey: "k", note: "127.0.0.1", tv: { host: "192.0.2.5" } }));
    fs.writeFileSync(path.join(dir, "sub", "more.json"), JSON.stringify({ remote: { host: "localhost" }, list: [{ ip: "::1" }] }));
    fs.writeFileSync(path.join(dir, "notes.txt"), "address: 127.0.0.1");
    const out = pointSettings(dir, new Set(["127.0.0.1", "localhost", "::1"]), "192.0.2.77");
    assert.deepEqual(out.map((c) => c.file + ":" + c.key).sort(), ["config.json:address", "sub/more.json:list.0.ip", "sub/more.json:remote.host"]);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(cfg.address, "192.0.2.77");
    assert.equal(cfg.note, "127.0.0.1", "only address-like keys change");
    assert.equal(cfg.tv.host, "192.0.2.5", "other devices' addresses stay");
    assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "address: 127.0.0.1", "only JSON files");
    pointSettings(dir, new Set(["192.0.2.77"]), "127.0.0.1");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).address, "127.0.0.1");
    console.log("  127.0.0.1 / localhost under address, host or ip keys switched both ways; other values and files untouched");
  }
  console.log("\nMOVE: all passed");
} catch (e) {
  failed = true;
  console.error("\nMOVE FAILED:", e.stack || e.message);
  console.error("bridge log:\n  " + logs.slice(-40).join("\n  "));
  console.error("mock calls:\n  " + remote.calls.slice(-40).join("\n  "));
} finally {
  link.stop();
  mover.stopControl();
  await tunnels.closeAll();
  await hub.stop();
  await remote.stop();
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
