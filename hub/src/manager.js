// Install / update / remove orchestration, run as background jobs whose log the web page follows.

import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Installer, InstallError, nameOf } from "./installer.js";
import { compareVersions } from "./util.js";

export class Manager extends EventEmitter {
  constructor({ store, supervisor, log }) {
    super();
    this.store = store;
    this.sup = supervisor;
    this.log = log;
    this.installer = new Installer({ dataDir: store.dataDir });
    this.jobs = new Map();
    this.busy = new Set(); // integration ids with a job running
    fs.rmSync(this.installer.tmpRoot, { recursive: true, force: true });
  }

  #job(kind, label) {
    const job = { id: crypto.randomBytes(5).toString("hex"), kind, label, state: "running", lines: [], started: Date.now(), result: null, error: null };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 30) this.jobs.delete(this.jobs.keys().next().value);
    const log = (l) => {
      job.lines.push(String(l));
      if (job.lines.length > 2000) job.lines.splice(0, 500);
    };
    return { job, log };
  }

  jobInfo(id) {
    return this.jobs.get(id) || null;
  }

  /** Starts an install from { git: url, ref } | { archive: Buffer, filename } | { local: path }. Returns the job. */
  install(req) {
    const label = req.git ? req.git : req.archive ? req.filename || "archive" : req.local;
    const { job, log } = this.#job("install", label);
    (async () => {
      let fetched;
      try {
        if (req.git) fetched = await this.installer.fetchGit(req.git, req.ref, log);
        else if (req.archive) fetched = await this.installer.fetchArchive(req.archive, req.filename, log);
        else if (req.local) fetched = await this.installer.fetchLocal(req.local, log);
        else throw new InstallError("Nothing to install");
        job.result = await this.#commit(fetched, log, req);
        job.state = "done";
        log(`done: ${job.result.name} ${job.result.version} is ${job.result.updated ? "updated" : "installed"}`);
      } catch (e) {
        job.state = "failed";
        job.error = e instanceof InstallError ? e.message : `${e.message}`;
        log(`FAILED: ${job.error}`);
      } finally {
        if (fetched?.tmp) fs.rmSync(fetched.tmp, { recursive: true, force: true });
      }
    })();
    return job;
  }

  /** Re-fetches a git-installed integration (newest tag, or its pinned branch) and reinstalls. */
  update(id) {
    const meta = this.store.get(id);
    if (!meta) throw new InstallError("Unknown integration");
    if (meta.source?.type !== "git") throw new InstallError("Only integrations installed from git can update themselves; upload the new archive instead");
    const ref = meta.source.followLatest ? "" : meta.source.ref || "";
    return this.install({ git: meta.source.url, ref });
  }

  async #commit(fetched, log, opts = {}) {
    const prep = await this.installer.prepare(fetched.dir, log);
    const id = prep.id;
    if (this.busy.has(id)) throw new InstallError(`${id} is already being installed`);
    this.busy.add(id);
    try {
      const old = this.store.get(id);
      const wasRunning = old && this.sup.info(id).state !== "stopped";
      if (old) {
        this.sup.note(id, `updating from ${old.version} to ${prep.driver.version || "?"}`);
        await this.sup.stop(id);
      }
      const dir = this.store.dir(id);
      const app = this.store.appDir(id);
      const backup = app + ".old";
      fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(backup, { recursive: true, force: true });
      if (fs.existsSync(app)) fs.renameSync(app, backup);
      try {
        fs.renameSync(fetched.dir, app);
      } catch (e) {
        if (fs.existsSync(backup)) fs.renameSync(backup, app);
        throw e;
      }
      fs.rmSync(backup, { recursive: true, force: true });
      fs.mkdirSync(this.store.configDir(id), { recursive: true });
      const meta = {
        id,
        driverId: prep.driver.driver_id,
        name: nameOf(prep.driver),
        version: prep.driver.version || "",
        icon: prep.driver.icon || "uc:integration",
        developer: prep.driver.developer?.name || "",
        homePage: prep.driver.home_page || prep.driver.developer?.url || "",
        description: prep.driver.description?.en || "",
        runtime: prep.runtime,
        command: old?.commandOverride || prep.command,
        detectedCommand: prep.command,
        commandOverride: old?.commandOverride || null,
        cwd: prep.cwd,
        pythonPath: prep.pythonPath || [],
        port: old?.port || this.store.freePort(),
        env: old?.env || {},
        autostart: old ? old.autostart : true,
        hold: opts.hold ? true : old?.hold || false,
        keepConnected: old?.keepConnected || false,
        ownDataDir: old ? !!old.ownDataDir : true,
        source: fetched.source,
        installedAt: old?.installedAt || Date.now(),
        updatedAt: Date.now(),
        latest: null
      };
      this.store.put(meta);
      this.emit("changed");
      if (opts.expectDriverId && meta.driverId !== opts.expectDriverId) {
        throw new InstallError(`that repository holds ${meta.driverId}, not ${opts.expectDriverId}`);
      }
      if (!opts.noStart && (meta.autostart || wasRunning)) await this.sup.start(id);
      return { id, name: meta.name, version: meta.version, updated: !!old };
    } finally {
      this.busy.delete(id);
    }
  }

  async remove(id) {
    if (!this.store.get(id)) throw new InstallError("Unknown integration");
    await this.sup.stop(id);
    this.sup.forget(id);
    this.store.remove(id);
    this.emit("changed");
  }

  async setOptions(id, { autostart, command, env, keepConnected }) {
    const meta = this.store.get(id);
    if (!meta) throw new InstallError("Unknown integration");
    if (typeof autostart === "boolean") meta.autostart = autostart;
    if (typeof keepConnected === "boolean") meta.keepConnected = keepConnected;
    if (command !== undefined) {
      if (command === null || command === "") {
        meta.commandOverride = null;
        meta.command = meta.detectedCommand;
      } else {
        const parts = Array.isArray(command) ? command.map(String) : splitArgs(String(command));
        if (!parts.length) throw new InstallError("Empty command");
        meta.commandOverride = parts;
        meta.command = parts;
      }
    }
    if (env && typeof env === "object") {
      meta.env = Object.fromEntries(Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !k.startsWith("UC_INTEGRATION_")).map(([k, v]) => [k, String(v)]));
    }
    this.store.put(meta);
    this.emit("changed");
    return meta;
  }

  /** Looks for newer release tags of git-installed integrations. */
  async checkUpdates() {
    for (const meta of this.store.list()) {
      if (meta.source?.type !== "git" || !meta.source.followLatest) continue;
      const tag = await this.installer.latest(meta.source, () => {});
      const current = meta.source.ref;
      const latest = tag && current && compareVersions(tag, current) > 0 ? tag : null;
      if (latest !== meta.latest) {
        meta.latest = latest;
        this.store.put(meta);
        this.emit("changed");
      }
    }
  }
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
