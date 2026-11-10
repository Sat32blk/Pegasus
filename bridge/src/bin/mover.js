// Moves an integration from the remote to the hub, and back. The Bridge runs the remote-side steps
// (it has the remote's API key) and asks the hub for the hub-side ones over the link.
//
// To the hub:
//   1. check      it's an installed (custom) integration that may move, with a GitHub home page
//   2. hub copy   the hub installs the same version, held back from the remote
//   3. snapshot   everything that refers to its entities is saved (on the remote and on the hub)
//   4. stand-in   the installed copy is updated in place with a stand-in (same ID, name, version,
//                 config files kept); it hands the config files over and passes traffic to the hub
//   5. settings   the hub puts the files in place and starts the integration
//   6. free slot  the installed copy is removed; the hub copy is registered under the same ID
//   7. instance   the instance is created again and the same entities selected
//   8. restore    the saved references are put back
//   9. verify     the references are counted against the snapshot
// Back to the remote: the hub builds the remote's release archive with the current config packed
// in; the Bridge snapshots, removes the external registration, installs the archive, recreates the
// instance and restores.
//
// A failed move stops where it is, keeps its snapshot, and can be retried from that step.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createTarGz } from "./tar.js";
import { RemoteOps, leaveOut, entityIdsOf, foreignIdsOf } from "./remote.js";

/** Integrations that must stay on the remote (they control the remote itself). */
export const STAYS = new Set(["pegasus_bridge", "pegasis_bridge"]); // the Bridge itself (pegasis_bridge: before the rename); everything else talks to the remote over its API
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Mover {
  constructor({ getCore, link, registrar, tunnels, state, save, log, binDir, dir, onChange = () => {} }) {
    this.getCore = getCore;
    this.link = link;
    this.registrar = registrar;
    this.tunnels = tunnels;
    this.state = state; // persisted: state.moves = { driverId: {...} }, state.controlPort
    this.state.moves ||= {};
    this.save = save;
    this.log = log;
    this.binDir = binDir;
    this.dir = dir; // where snapshots are kept on the remote
    this.onChange = onChange;
    this.waiters = new Map(); // driverId -> resolve(settings)
    this.running = new Set();
  }

  remote() {
    const core = this.getCore();
    if (!core) throw new Error("the Bridge has no access to the remote: run its setup again");
    return new RemoteOps(core, this.log);
  }

  // ------------------------------------------------------------------ control endpoint (stand-ins)

  async startControl() {
    if (this.server) return;
    const server = http.createServer((req, res) => this.#control(req, res));
    const tryListen = (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server.address().port));
      });
    let port;
    try {
      port = await tryListen(this.state.controlPort || 0);
    } catch {
      port = await tryListen(0);
    }
    this.server = server;
    if (this.state.controlPort !== port) {
      this.state.controlPort = port;
      this.save();
    }
  }

  stopControl() {
    this.server?.close();
    this.server = null;
  }

  async #control(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const m = /^\/standin\/([^/]+)\/(settings|endpoint)$/.exec(req.url || "");
    if (!m) return send(404, { error: "not found" });
    const driverId = decodeURIComponent(m[1]);
    const mv = this.state.moves[driverId];
    const token = String(req.headers["x-pegasus-token"] || req.headers["x-pegasis-token"] || ""); // older stand-ins send the old name
    if (!mv?.token || !safeEqual(token, mv.token)) return send(403, { error: "unknown stand-in" });
    if (m[2] === "endpoint" && req.method === "GET") {
      const port = await this.tunnels.ensure(mv.hubId, this.registrar.state.hosted?.[mv.hubId]?.port);
      return send(200, { port });
    }
    if (m[2] === "settings" && req.method === "POST") {
      const chunks = [];
      let n = 0;
      for await (const c of req) {
        n += c.length;
        if (n > 80 * 1024 * 1024) return send(413, { error: "too large" });
        chunks.push(c);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, { error: "bad body" });
      }
      const w = this.waiters.get(driverId);
      if (w) {
        this.waiters.delete(driverId);
        w({ config: body.config || [], data: body.data || [] });
      }
      return send(200, { ok: true });
    }
    send(405, { error: "method" });
  }

  // ------------------------------------------------------------------ bookkeeping

  #begin(driverId, dir, extra = {}) {
    if (this.running.has(driverId)) throw new Error(`${driverId} is already moving`);
    this.running.add(driverId);
    const mv = { dir, status: "running", step: "check", log: [], started: Date.now(), updated: Date.now(), ...extra };
    this.state.moves[driverId] = mv;
    this.save();
    this.onChange();
    return mv;
  }

  #step(driverId, step, note) {
    const mv = this.state.moves[driverId];
    mv.step = step;
    mv.updated = Date.now();
    if (note) mv.log.push(`${new Date().toISOString().slice(11, 19)} ${note}`);
    if (mv.log.length > 60) mv.log.splice(0, mv.log.length - 60);
    this.log(`move ${driverId}: ${note || step}`);
    this.save();
    this.onChange();
  }

  #end(driverId, status, error) {
    const mv = this.state.moves[driverId];
    mv.status = status;
    mv.error = error || null;
    mv.updated = Date.now();
    if (error) mv.log.push(`${new Date().toISOString().slice(11, 19)} STOPPED at "${mv.step}": ${error}`);
    // the stand-in keeps its access code for as long as it runs (slot kept); otherwise it's gone
    if (status === "done" && !(mv.dir === "toHub" && mv.keepSlot)) delete mv.token;
    this.running.delete(driverId);
    this.save();
    this.onChange();
  }

  summary() {
    return Object.fromEntries(Object.entries(this.state.moves).map(([id, m]) => [id, { dir: m.dir, status: m.status, step: m.step, error: m.error || null, log: m.log.slice(-15), started: m.started, updated: m.updated, canRetry: m.status === "failed" && !!m.snapshotFile, missing: m.status === "failed" && m.snapshotFile ? missingOf(m) : [] }]));
  }

  #saveSnapshot(driverId, snap) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${driverId}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
    fs.writeFileSync(file, JSON.stringify(snap));
    // keep the newest five per integration
    const mine = fs.readdirSync(this.dir).filter((f) => f.startsWith(driverId + "-")).sort().reverse().slice(5);
    for (const f of mine) fs.rmSync(path.join(this.dir, f), { force: true });
    return file;
  }

  /** What may move, for the hub's list. */
  async integrations() {
    const list = await this.remote().integrations();
    // installed integrations whose driver.json doesn't link GitHub: the hub looks them up in the
    // integration catalog
    const unknown = list.filter((i) => i.type === "CUSTOM" && !STAYS.has(i.driver_id) && !/github\.com\//.test(i.home_page)).map((i) => i.driver_id);
    const found = unknown.length ? await this.link.call("catalog.repos", { driverIds: unknown }, 20000).catch(() => ({})) : {};
    return list.map((i) => {
      const repo = /github\.com\//.test(i.home_page) ? i.home_page : found[i.driver_id] || "";
      return {
        ...i,
        ...(repo !== i.home_page && repo ? { home_page: repo, repoFrom: "catalog" } : {}),
        movable: i.type === "CUSTOM" && !STAYS.has(i.driver_id) && !!repo,
        why: i.type !== "CUSTOM" ? (i.type === "EXTERNAL" ? "not installed on the remote" : "built into the remote") : STAYS.has(i.driver_id) ? "this is the Bridge itself" : !repo ? "no GitHub repository to get its code from (not in its driver.json, nor in the integration catalog)" : null
        // (move progress travels in the status report; not repeated here)
      };
    });
  }

  // ------------------------------------------------------------------ to the hub

  /** Starts a move to the hub in the background. Returns at once. */
  toHub(driverId, { keepSlot = false } = {}) {
    this.#begin(driverId, "toHub", { keepSlot });
    this.#toHub(driverId, keepSlot)
      .then(() => this.#end(driverId, "done"))
      .catch((e) => this.#end(driverId, "failed", e.message));
    return { started: true };
  }

  async #toHub(driverId, keepSlot) {
    const remote = this.remote();
    const mv = this.state.moves[driverId];
    const d = await remote.driver(driverId);
    if (!d) throw new Error("not installed on the remote");
    if (d.driver_type !== "CUSTOM") throw new Error(`it is a ${String(d.driver_type).toLowerCase()} integration, not one installed on the remote`);
    if (STAYS.has(driverId)) throw new Error("the Bridge itself has to stay on the remote");
    let homePage = d.home_page || d.developer?.url || "";
    if (!/github\.com\//.test(homePage)) {
      const found = await this.link.call("catalog.repos", { driverIds: [driverId] }, 20000).catch(() => ({}));
      if (!found[driverId]) throw new Error("it has no GitHub home page to get its code from, and it isn't in the integration catalog");
      homePage = found[driverId];
    }
    const inst = (await remote.instancesOf(driverId))[0] || null;

    this.#step(driverId, "hub copy", `the hub installs ${text(d.name)} ${d.version} from ${homePage}`);
    const prep = await this.link.call("move.prepare", { driverId, version: d.version, homePage, name: text(d.name) }, 20 * 60 * 1000);
    mv.hubId = prep.hubId;
    this.save();

    let snap = null;
    if (inst) {
      this.#step(driverId, "snapshot", `saving every place ${inst.integration_id} is used`);
      snap = await remote.snapshot(inst.integration_id);
      mv.snapshotFile = this.#saveSnapshot(driverId, snap);
      mv.instanceId = inst.integration_id;
      await this.link.call("move.saveSnapshot", { hubId: mv.hubId, snapshot: snap }, 60000).catch((e) => this.log(`snapshot copy to hub failed: ${e.message}`));
      this.#step(driverId, "snapshot", `saved: ${describeRefs(snap.references)}`);
    }

    this.#step(driverId, "stand-in", "swapping the installed copy for a stand-in (settings kept)");
    mv.token = crypto.randomBytes(18).toString("hex");
    this.save();
    const settingsArrive = new Promise((resolve, reject) => {
      this.waiters.set(driverId, resolve);
      setTimeout(() => {
        if (this.waiters.delete(driverId)) reject(new Error("the stand-in did not hand over the settings within 3 minutes"));
      }, 180000);
    });
    await remote.install(this.standInArchive(d, mv.token), `pegasis-standin-${driverId}.tar.gz`, { update: true });
    const settings = await settingsArrive;

    this.#step(driverId, "settings", `handing ${settings.config.length + settings.data.length} settings file(s) to the hub and starting it there`);
    await this.link.call("move.importSettings", { hubId: mv.hubId, config: settings.config, data: settings.data }, 5 * 60 * 1000);

    if (keepSlot) {
      this.#step(driverId, "done", "running on the hub through the stand-in (the slot is kept)");
      return;
    }
    await this.#freeSlot(driverId, snap);
  }

  async #freeSlot(driverId, snap) {
    const remote = this.remote();
    const mv = this.state.moves[driverId];
    this.#step(driverId, "free slot", "removing the installed copy to free its slot");
    await remote.deleteDriver(driverId);
    await this.link.call("move.release", { hubId: mv.hubId }, 60000);
    this.#step(driverId, "free slot", "registering the hub copy under the same ID");
    const until = Date.now() + 90000;
    for (;;) {
      await this.registrar.resync();
      const d = await remote.driver(driverId);
      if (d?.driver_type === "EXTERNAL") break;
      if (Date.now() > until) throw new Error("the hub copy was not registered on the remote within 90 s");
      await sleep(1500);
    }
    if (!snap) {
      this.#step(driverId, "done", "moved (it had no instance, nothing to restore)");
      return;
    }
    await this.#restore(driverId, snap);
  }

  async #restore(driverId, snap) {
    const remote = this.remote();
    const mv = this.state.moves[driverId];
    this.#step(driverId, "instance", "creating the instance again and selecting the same entities");
    let made;
    try {
      made = await remote.recreateInstance(driverId, snap);
    } catch (e) {
      if (e.missing) mv.missing = e.missing; // the page offers "continue without them"
      throw e;
    }
    delete mv.missing;
    delete mv.missingForeign;
    const newId = made.id;
    if (made.skipped.length) {
      snap = leaveOut(snap, made.skipped, "not offered by the integration before the move either");
      mv.snapshotFile = this.#saveSnapshot(driverId, snap);
      this.#step(driverId, "instance", `left out ${made.skipped.join(", ")}: the integration didn't offer ${made.skipped.length === 1 ? "it" : "them"} before the move either`);
    }
    if (newId !== snap.instanceId) this.#step(driverId, "instance", `the remote named the instance ${newId} (was ${snap.instanceId}); references are rewritten`);
    mv.newInstanceId = newId;
    // every entity the saved places use must exist on the remote now, or the remote refuses to
    // put it back ("Invalid entity_id"). Ones the integration doesn't offer are left out; ones it
    // offers but that didn't get selected stop the move with "continue without them" offered.
    const absent = [];
    for (const own of entityIdsOf(snap)) if (!(await remote.getOrNull(`/entities/${encodeURIComponent(newId + "." + own)}`))) absent.push(own);
    if (absent.length) {
      const offered = await remote.offeredIds(newId).catch(() => null);
      const gone = offered ? absent.filter((x) => !offered.has(x)) : [];
      const pending = absent.filter((x) => !gone.includes(x));
      if (gone.length) {
        snap = leaveOut(snap, gone, "not offered by the integration");
        mv.snapshotFile = this.#saveSnapshot(driverId, snap);
        this.#step(driverId, "instance", `left out ${gone.join(", ")}: the integration doesn't offer ${gone.length === 1 ? "it" : "them"} (left over from an earlier version or setup?)`);
      }
      if (pending.length) {
        await remote.configureEntities(newId, newId, pending, { tries: 10 }).catch(() => {});
        const still = [];
        for (const own of pending) if (!(await remote.getOrNull(`/entities/${encodeURIComponent(newId + "." + own)}`))) still.push(own);
        if (still.length) {
          mv.missing = still;
          throw new Error(`could not select ${still.length} of ${entityIdsOf(snap).length} entities (${still.join(", ")}): the remote has no such entity, so it would refuse to put ${still.length === 1 ? "it" : "them"} back into activities`);
        }
      }
    }
    // the places are written back whole, so other integrations' entities in them must exist too
    const dead = [];
    const unknown = [];
    for (const id of foreignIdsOf(snap)) {
      if (await remote.getOrNull(`/entities/${encodeURIComponent(id)}`)) continue;
      const inst = id.split(".").slice(0, 2).join(".");
      if (await remote.getOrNull(`/intg/instances/${encodeURIComponent(inst)}`)) unknown.push(id);
      else dead.push(id);
    }
    if (dead.length) {
      snap = leaveOut(snap, dead, "its integration is no longer on the remote", { foreign: true });
      mv.snapshotFile = this.#saveSnapshot(driverId, snap);
      this.#step(driverId, "restore", `left out ${dead.join(", ")}: ${dead.length === 1 ? "it belongs" : "they belong"} to an integration that is no longer on the remote, so ${dead.length === 1 ? "that step" : "those steps"} couldn't run anyway and the remote won't save an activity that still has ${dead.length === 1 ? "it" : "them"}`);
    }
    if (unknown.length) {
      mv.missing = unknown;
      mv.missingForeign = unknown;
      throw new Error(`could not select ${unknown.length} of ${unknown.length} entities (${unknown.join(", ")}): they belong to other integrations, which don't offer them now (is that device on and its integration connected?); the remote refuses activities that use missing entities`);
    }
    this.#step(driverId, "restore", "putting the saved references back");
    const done = await remote.restore(snap, newId);
    this.#step(driverId, "restore", `${done.length} change(s) written`);
    this.#step(driverId, "verify", "checking every reference is back");
    const v = await remote.verify(snap, newId);
    if (!v.ok) throw new Error(`some references did not come back: ${v.missing.join("; ")}`);
    this.#step(driverId, "done", `all references are back (${describeRefs(v.references)})`);
  }

  /** Retries a failed move from where it can safely continue (reads its saved snapshot). */
  retry(driverId, { leaveOut: drop = [] } = {}) {
    const mv = this.state.moves[driverId];
    if (!mv || mv.status !== "failed") throw new Error("no failed move to retry");
    let snap = mv.snapshotFile ? JSON.parse(fs.readFileSync(mv.snapshotFile, "utf8")) : null;
    // "continue without them": the entities that couldn't be selected are left out of what is put back
    drop = (Array.isArray(drop) ? drop : []).map(String).filter((x) => missingOf(mv).includes(x));
    if (snap && drop.length) {
      const foreign = drop.filter((x) => (mv.missingForeign || []).includes(x));
      const own = drop.filter((x) => !foreign.includes(x));
      if (own.length) snap = leaveOut(snap, own, "left out at the owner's request (the integration didn't offer them)");
      if (foreign.length) snap = leaveOut(snap, foreign, "left out at the owner's request (another integration didn't offer them)", { foreign: true });
      delete mv.missingForeign;
      mv.snapshotFile = this.#saveSnapshot(driverId, snap);
      mv.log.push(`${new Date().toISOString().slice(11, 19)} continuing without ${drop.join(", ")}`);
      delete mv.missing;
    }
    this.running.add(driverId);
    mv.status = "running";
    mv.error = null;
    this.save();
    const go = async () => {
      if (mv.dir === "toHub") {
        const d = await this.remote().driver(driverId);
        if (d?.driver_type === "CUSTOM") return this.#toHub(driverId, mv.keepSlot); // never got past the stand-in
        if (!d || d.driver_type !== "EXTERNAL") return this.#freeSlot(driverId, snap);
        return snap ? this.#restore(driverId, snap) : null;
      }
      const d = await this.remote().driver(driverId);
      if (d?.driver_type === "CUSTOM") {
        // already installed on the remote again: put the references back, then finish like a move back
        if (snap) await this.#restore(driverId, snap);
        await this.#cleanupHub(driverId);
        this.#step(driverId, "done", "back on the remote");
        return;
      }
      return this.#toRemote(driverId);
    };
    go()
      .then(() => this.#end(driverId, "done"))
      .catch((e) => this.#end(driverId, "failed", e.message));
    return { started: true };
  }

  // ------------------------------------------------------------------ back to the remote

  toRemote(driverId) {
    const prev = this.state.moves[driverId];
    const viaStandIn = prev?.dir === "toHub" && prev.keepSlot && prev.status === "done";
    const hubId = Object.entries(this.registrar.state.hosted || {}).find(([, h]) => h.remoteId === driverId)?.[0] || (viaStandIn ? prev.hubId : null);
    if (!hubId) throw new Error(`${driverId} isn't running from the hub on this remote`);
    this.#begin(driverId, "toRemote", { hubId, viaStandIn });
    this.#toRemote(driverId)
      .then(() => this.#end(driverId, "done"))
      .catch((e) => this.#end(driverId, "failed", e.message));
    return { started: true };
  }

  async #toRemote(driverId) {
    const remote = this.remote();
    const mv = this.state.moves[driverId];

    // save every use first, while the hub copy still runs: the remote can only list an
    // integration's entities while it is active
    const inst = (await remote.instancesOf(driverId))[0] || null;
    let snap = null;
    if (inst) {
      this.#step(driverId, "snapshot", `saving every place ${inst.integration_id} is used`);
      snap = await remote.snapshot(inst.integration_id);
      mv.snapshotFile = this.#saveSnapshot(driverId, snap);
      this.#step(driverId, "snapshot", `saved: ${describeRefs(snap.references)}`);
    }

    this.#step(driverId, "hub package", "the hub stops the integration and packs the remote's release with its current settings");
    const pkg = await this.link.call("move.prepareBack", { hubId: mv.hubId }, 20 * 60 * 1000);
    this.#step(driverId, "download", `fetching ${pkg.filename} (${Math.round(pkg.size / 1024)} KB) from the hub`);
    const parts = [];
    for (let off = 0; off < pkg.size; ) {
      const r = await this.link.call("move.chunk", { hubId: mv.hubId, offset: off, length: 4 * 1024 * 1024 }, 120000);
      const buf = Buffer.from(r.b64, "base64");
      if (!buf.length) throw new Error("the hub sent an empty chunk");
      parts.push(buf);
      off += buf.length;
    }
    const archive = Buffer.concat(parts);
    if (crypto.createHash("sha256").update(archive).digest("hex") !== pkg.sha256) throw new Error("the archive arrived damaged (checksum mismatch)");

    const d = await remote.driver(driverId);
    if (mv.viaStandIn) {
      // the stand-in still holds the old settings; a fresh install brings the hub's current ones
      this.#step(driverId, "remove stand-in", "removing the stand-in");
      if (d && d.driver_type !== "CUSTOM") throw new Error(`${driverId} on the remote is ${d.driver_type}, not the stand-in`);
    } else {
      this.#step(driverId, "remove external", "removing the hub registration");
      if (d && d.driver_type !== "EXTERNAL") throw new Error(`${driverId} on the remote is ${d.driver_type}, not the hub's registration`);
    }
    await remote.deleteDriver(driverId);
    this.registrar.forget(mv.hubId);

    this.#step(driverId, "install", `installing ${pkg.filename} on the remote`);
    await remote.install(archive, pkg.filename, { update: false });
    const until = Date.now() + 120000;
    while (!(await remote.driver(driverId))) {
      if (Date.now() > until) throw new Error("the remote did not list the installed integration within 2 minutes");
      await sleep(1500);
    }

    if (snap) await this.#restore(driverId, snap);
    await this.#cleanupHub(driverId);
    this.#step(driverId, "done", "back on the remote");
  }

  /** The last step of a move back: the hub removes its (stopped) copy. */
  async #cleanupHub(driverId) {
    const mv = this.state.moves[driverId];
    if (!mv?.hubId) return;
    this.#step(driverId, "hub cleanup", "removing the hub copy");
    await this.link.call("move.finishBack", { hubId: mv.hubId }, 60000);
    mv.hubCleaned = true;
    this.save();
  }

  /**
   * Finishes moves back that ended without removing the hub's copy (a Retry in Bridge 0.3.4 and
   * older skipped that step). Called when the link to the hub comes up.
   */
  async reconcile() {
    for (const [driverId, mv] of Object.entries(this.state.moves || {})) {
      if (mv.dir !== "toRemote" || mv.status !== "done" || mv.hubCleaned || !mv.hubId || this.running.has(driverId)) continue;
      try {
        await this.link.call("move.finishBack", { hubId: mv.hubId }, 60000);
        mv.hubCleaned = true;
        mv.log = [...(mv.log || []), `${new Date().toTimeString().slice(0, 8)} removed the hub copy left behind`].slice(-40);
        this.save();
        this.log?.(`move ${driverId}: removed the hub copy left behind by an earlier move back`);
      } catch (e) {
        this.log?.(`move ${driverId}: could not remove the hub copy yet: ${e.message}`);
      }
    }
  }

  // ------------------------------------------------------------------ stand-in archive

  /** A custom-integration archive with the same identity as d, running the stand-in. */
  standInArchive(d, token) {
    const meta = {
      driver_id: d.driver_id,
      version: d.version,
      name: d.name,
      icon: d.icon,
      description: d.description,
      developer: d.developer,
      home_page: d.home_page,
      setup_data_schema: d.setup_data_schema,
      release_date: d.release_date,
      min_core_api: d.min_core_api
    };
    for (const k of Object.keys(meta)) if (meta[k] === undefined || meta[k] === null) delete meta[k];
    const entries = [
      { name: "driver.json", data: JSON.stringify(meta, null, 2) },
      { name: "bin/driver.js", data: fs.readFileSync(path.join(this.binDir, "standin", "driver.js")), mode: 0o755 },
      { name: "bin/package.json", data: JSON.stringify({ name: "pegasis-standin", private: true, type: "module", main: "driver.js" }) },
      { name: "bin/standin.json", data: JSON.stringify({ driverId: d.driver_id, control: `http://127.0.0.1:${this.state.controlPort}`, token }) }
    ];
    const ws = path.join(this.binDir, "node_modules", "ws");
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
        else if (e.isFile()) entries.push({ name: `${rel}/${e.name}`, data: fs.readFileSync(p) });
      }
    };
    walk(ws, "bin/node_modules/ws");
    return createTarGz(entries);
  }
}

function describeRefs(refs) {
  const parts = Object.entries(refs || {}).filter(([k, n]) => n && k !== "entities");
  const acts = parts.filter(([k]) => k.startsWith("activity")).length;
  const macros = parts.filter(([k]) => k.startsWith("macro")).length;
  const home = parts.filter(([k]) => k.startsWith("home")).length;
  return `${refs?.entities || 0} entities, used in ${acts} activit${acts === 1 ? "y" : "ies"}, ${macros} macro${macros === 1 ? "" : "s"}, ${home} home-screen page/group${home === 1 ? "" : "s"}`;
}

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const text = (v) => (typeof v === "string" ? v : v?.en || (v && Object.values(v)[0]) || "");

/** Entities a failed move couldn't select (recorded, or read from the error of an older Bridge). */
function missingOf(mv) {
  if (Array.isArray(mv.missing)) return mv.missing;
  const m = /could not select \d+ of \d+ entities \(([^)]*)\)/.exec(mv.error || "");
  return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
}
