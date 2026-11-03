// The Bridge's ID rules: real driver_id first, pgs_ fallback when taken, never touch what isn't ours.
import assert from "node:assert/strict";
import { Registrar, registrationBody } from "../bridge/src/bin/registrar.js";

class FakeCore {
  constructor(drivers = {}) {
    this.d = new Map(Object.entries(drivers));
    this.calls = [];
  }
  err(status) {
    return Object.assign(new Error(`HTTP ${status}`), { status });
  }
  async get(p) {
    const id = decodeURIComponent(p.split("/").pop());
    if (!this.d.has(id)) throw this.err(404);
    return this.d.get(id);
  }
  async post(p, b) {
    this.calls.push(`POST ${b.driver_id}`);
    // the real remote refuses a registration without these (found on firmware, Nov 2026)
    for (const f of ["driver_url", "name", "version"]) if (!b[f]) throw Object.assign(new Error(`HTTP 400 Missing field: ${f}`), { status: 400 });
    if (this.d.has(b.driver_id)) throw this.err(422);
    this.d.set(b.driver_id, { ...b, driver_type: "EXTERNAL" });
  }
  async patch(p, b) {
    const id = decodeURIComponent(p.split("/").pop());
    this.calls.push(`PATCH ${id}`);
    Object.assign(this.d.get(id), b);
  }
  async delete(p) {
    const id = decodeURIComponent(p.split("/").pop());
    this.calls.push(`DELETE ${id}`);
    this.d.delete(id);
  }
}
class FakeTunnels {
  constructor() {
    this.m = new Map();
  }
  async ensure(id, port) {
    if (!this.m.has(id)) this.m.set(id, port);
    return this.m.get(id);
  }
  has(id) {
    return this.m.has(id);
  }
  async remove(id) {
    this.m.delete(id);
  }
}
const drv = (id, driver_id, extra = {}) => ({ id, driver_id, name: id, version: "1.0.0", icon: "uc:tv", state: "running", ...extra });
function make(core, state = {}) {
  const changes = [];
  const r = new Registrar({ getCore: () => core, tunnels: new FakeTunnels(), state, save: () => {}, onChange: (m) => changes.push(m), fetchMetadata: async () => ({}) });
  return { r, state, changes };
}
let n = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || n++;

// a typical remote: one integration installed directly, a built-in one, and the Integration Manager (external)
const realRemote = () =>
  new FakeCore({
    samsungtv_driver: { driver_id: "samsungtv_driver", driver_type: "CUSTOM", name: { en: "Samsung TV" } },
    uc_roku_driver: { driver_id: "uc_roku_driver", driver_type: "LOCAL", name: { en: "Roku" } },
    intg_manager_driver: { driver_id: "intg_manager_driver", driver_type: "EXTERNAL", driver_url: "ws://192.0.2.10:8088", name: { en: "Integration Manager" } }
  });

{
  const core = realRemote();
  const { r, state, changes } = make(core);
  await r.sync([drv("plex", "plex_driver")], []);
  assert.equal(state.hosted.plex.remoteId, "plex_driver");
  assert.equal(core.d.get("plex_driver").driver_url, "ws://127.0.0.1:9700");
  assert.deepEqual(changes.at(-1), { plex: "plex_driver" });
  ok("free ID: registered under its real driver_id (plex_driver)");

  await r.sync([drv("plex", "plex_driver"), drv("samsungtv_driver", "samsungtv_driver")], []);
  assert.equal(state.hosted.samsungtv_driver.remoteId, "pgs_samsungtv_driver");
  assert.equal(core.d.get("samsungtv_driver").driver_type, "CUSTOM");
  assert.match(r.summary().notes[0][1], /already used/);
  ok("installed directly on the remote: falls back to pgs_samsungtv_driver, the installed one untouched");

  await r.sync([drv("uc_roku_driver", "uc_roku_driver")], []);
  assert.equal(state.hosted.uc_roku_driver.remoteId, "pgs_uc_roku_driver");
  ok("built-in ID: falls back to pgs_");

  await r.sync([drv("intg_manager_driver", "intg_manager_driver")], []);
  assert.equal(state.hosted.intg_manager_driver.remoteId, "pgs_intg_manager_driver");
  assert.equal(core.d.get("intg_manager_driver").driver_url, "ws://192.0.2.10:8088");
  ok("someone else's external driver with that ID: not adopted, not changed");

  const calls = core.calls.length;
  await r.sync([drv("plex", "plex_driver")], []);
  assert.equal(core.calls.length, calls);
  ok("second sync changes nothing");

  await r.sync([], ["plex", "samsungtv_driver"]);
  assert.ok(!core.d.has("plex_driver"));
  assert.ok(!core.d.has("pgs_samsungtv_driver"));
  assert.ok(core.d.has("samsungtv_driver"), "deleted the directly installed one!");
  ok("uninstalled on the hub: removes only its own registrations");
}
{
  const core = realRemote();
  core.d.set("pgs_old", { driver_id: "pgs_old", driver_type: "EXTERNAL", driver_url: "ws://127.0.0.1:9705" });
  const { r, state } = make(core, { ports: { pgs_old: 9705 }, registered: { pgs_old: { name: "Old", version: "1" } } });
  await r.sync([drv("old", "old_driver")], []);
  assert.equal(state.hosted.old.remoteId, "pgs_old");
  assert.ok(!core.d.has("old_driver"));
  assert.ok(!state.ports && !state.registered);
  ok("registered by Bridge 0.1.x: keeps its pgs_ ID (renaming would wipe its activities)");
}
{
  const core = new FakeCore();
  const { r, state } = make(core);
  await r.sync([drv("lg", "lgwebos_driver")], []);
  core.d.delete("lgwebos_driver");
  await r.sync([drv("lg", "lgwebos_driver")], []);
  assert.equal(state.hosted.lg.remoteId, "lgwebos_driver");
  assert.ok(core.d.has("lgwebos_driver"));
  ok("deleted on the remote: added back under the same ID");

  core.d.set("lgwebos_driver", { driver_id: "lgwebos_driver", driver_type: "CUSTOM" });
  await r.sync([drv("lg", "lgwebos_driver")], []);
  assert.equal(state.hosted.lg.remoteId, "pgs_lg");
  assert.equal(core.d.get("lgwebos_driver").driver_type, "CUSTOM");
  ok("its ID later installed directly on the remote: lets go and moves to pgs_");
}
{
  const core = new FakeCore();
  core.d.set("adopt_me", { driver_id: "adopt_me", driver_type: "EXTERNAL", driver_url: "ws://127.0.0.1:9700" });
  const { r, state } = make(core);
  await r.sync([drv("adopt", "adopt_me")], []);
  assert.equal(state.hosted.adopt.remoteId, "adopt_me");
  assert.ok(!core.calls.includes("POST adopt_me"));
  ok("external driver already pointing at our own endpoint: adopted (e.g. Bridge settings lost)");
}
{
  const core = new FakeCore();
  const { r, state } = make(core);
  await r.sync([drv("weird", "has spaces!")], []);
  assert.equal(state.hosted.weird.remoteId, "pgs_weird");
  await r.sync([drv("down", "down_driver", { state: "crashed" })], []);
  assert.ok(!state.hosted.down.remoteId);
  assert.match(r.summary().problems.find(([id]) => id === "down")[1], /crashed/);
  ok("invalid driver_id → pgs_; not running → waits, nothing registered");
}
{
  const meta = { driver_id: "uc-intg-govee", version: "0.3.5", name: { en: "Govee", de: "Govee" }, description: { en: "Lights" }, icon: "uc:g", release_date: "2025-10-23", setup_data_schema: { title: { en: "x" }, settings: [] }, port: 9090, mdns: {} };
  const b = registrationBody("uc-intg-govee", "ws://127.0.0.1:9700", meta, drv("uc-intg-govee", "uc-intg-govee"));
  assert.deepEqual(Object.keys(b).sort(), ["description", "device_discovery", "driver_id", "driver_url", "enabled", "icon", "name", "release_date", "setup_data_schema", "version"].sort());
  assert.equal(b.version, "0.3.5");
  assert.deepEqual(b.name, { en: "Govee", de: "Govee" });
  const fb = registrationBody("x", "ws://127.0.0.1:9701", {}, drv("x", "x", { name: "X", version: "1.2.3", icon: "custom:x.png" }));
  assert.equal(fb.version, "1.2.3");
  assert.deepEqual(fb.name, { en: "X" });
  assert.equal(fb.icon, "uc:integration");
  assert.ok(!("release_date" in fb));
  ok("registration body: the fields of UC's example, from the driver's own details (hub's as fallback)");
}
console.log(`registrar-test: ${n} checks ok`);
