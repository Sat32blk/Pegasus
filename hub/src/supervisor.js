// Keeps each hosted integration driver running as a child process, listening on its own port on
// 127.0.0.1 inside the container. Restarts crashed drivers with backoff and keeps their logs.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { portOpen, sleep } from "./util.js";
import { redact } from "./redact.js";
import { dockerByConfigPath } from "./installer.js";

const LOG_LINES = 800;
const LOG_FILE_MAX = 2 * 1024 * 1024;

export class Supervisor extends EventEmitter {
  /** extraEnv(id): environment added for one integration (the Pegasus hints for developers) */
  constructor({ store, log, extraEnv = () => ({}) }) {
    super();
    this.store = store;
    this.log = log;
    this.extraEnv = extraEnv;
    this.procs = new Map(); // id -> { child, state, since, restarts, timer, wantRunning, lines, startedAt, lastExit }
    this.usageNow = new Map(); // id -> { cpu (% of one core), memMB }
    this.lastTicks = new Map(); // id -> { ticks, at }
    this.usageTimer = setInterval(() => this.#sampleUsage(), 5000);
    this.usageTimer.unref?.();
  }

  /** CPU and memory of each running driver, with its child processes (Linux /proc; nothing elsewhere). */
  #sampleUsage() {
    let stats;
    try {
      stats = fs
        .readdirSync("/proc")
        .filter((d) => /^\d+$/.test(d))
        .map((pid) => {
          try {
            const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            const f = raw.slice(raw.lastIndexOf(")") + 2).split(" "); // fields from 3 (state) on
            return { pid: Number(pid), ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), rssPages: Number(f[21]) };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return; // not Linux
    }
    const kids = new Map();
    for (const p of stats) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p);
    const now = Date.now();
    for (const [id, p] of this.procs) {
      const pid = p.child?.pid;
      if (!pid) {
        this.usageNow.delete(id);
        this.lastTicks.delete(id);
        continue;
      }
      let ticks = 0;
      let pages = 0;
      const walk = (n) => {
        ticks += n.ticks;
        pages += n.rssPages;
        for (const c of kids.get(n.pid) || []) walk(c);
      };
      const root = stats.find((x) => x.pid === pid);
      if (!root) continue;
      walk(root);
      const prev = this.lastTicks.get(id);
      this.lastTicks.set(id, { ticks, at: now, pid });
      const cpu = prev && prev.pid === pid && now > prev.at ? (((ticks - prev.ticks) / 100) / ((now - prev.at) / 1000)) * 100 : null;
      this.usageNow.set(id, { cpu: cpu == null ? null : Math.max(0, Math.round(cpu * 10) / 10), memMB: Math.round((pages * 4096) / 1048576) });
    }
  }

  usage(id) {
    return this.usageNow.get(id) || null;
  }

  info(id) {
    const p = this.procs.get(id);
    return p
      ? { state: p.state, since: p.since, restarts: p.restarts, pid: p.child?.pid || null, lastExit: p.lastExit || null }
      : { state: "stopped", since: null, restarts: 0, pid: null, lastExit: null };
  }

  logs(id) {
    return this.procs.get(id)?.lines || readTail(this.store.logFile(id));
  }

  #entry(id) {
    let p = this.procs.get(id);
    if (!p) {
      p = { child: null, state: "stopped", since: Date.now(), restarts: 0, timer: null, wantRunning: false, lines: readTail(this.store.logFile(id)) };
      this.procs.set(id, p);
    }
    return p;
  }

  #set(id, state) {
    const p = this.#entry(id);
    if (p.state === state) return;
    p.state = state;
    p.since = Date.now();
    this.emit("change", id, state);
  }

  #line(id, text, stream = "out") {
    const p = this.#entry(id);
    const line = `${new Date().toISOString().slice(11, 23)} ${stream === "err" ? "!" : " "} ${redact(text)}`;
    p.lines.push(line);
    if (p.lines.length > LOG_LINES) p.lines.splice(0, p.lines.length - LOG_LINES);
    const f = this.store.logFile(id);
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > LOG_FILE_MAX) fs.renameSync(f, f + ".1");
      fs.appendFileSync(f, line + "\n");
    } catch {
      /* logging must never take the hub down */
    }
  }

  note(id, text) {
    this.#line(id, `[hub] ${text}`);
  }

  async start(id) {
    const meta = this.store.get(id);
    if (!meta) throw new Error(`unknown integration ${id}`);
    const p = this.#entry(id);
    p.wantRunning = true;
    if (p.child) return;
    clearTimeout(p.timer);
    await this.#ensurePort(id);
    // installed before the hub looked for this: look once
    const m0 = this.store.get(id);
    if (m0 && m0.dockerConfigPath === undefined) this.store.put({ ...m0, dockerConfigPath: dockerByConfigPath(this.store.appDir(id)) });
    if (p.child || !p.wantRunning) return;
    this.#spawn(id, this.store.get(id));
  }

  /**
   * With host networking the integrations' ports are on the server itself, where another program
   * may already use one. Then the integration would fail to start while the hub (seeing the port
   * open) took the other program for it; so it gets a free port first.
   */
  async #ensurePort(id) {
    const meta = this.store.get(id);
    if (!(await portOpen(meta.port))) return;
    const taken = new Set(this.store.list().map((m) => m.port));
    let port = meta.port + 1;
    for (let i = 0; i < 500; i++, port++) {
      if (taken.has(port) || (await portOpen(port))) continue;
      this.note(id, `port ${meta.port} is used by another program on this server; using ${port}`);
      this.store.put({ ...meta, port });
      return;
    }
    this.note(id, `port ${meta.port} is used by another program and no free port was found nearby`);
  }

  #spawn(id, meta) {
    const p = this.#entry(id);
    const appDir = this.store.appDir(id);
    const cwd = path.join(appDir, meta.cwd || "");
    const venv = path.join(appDir, ".venv");
    const [cmd, ...args] = meta.command.map((c) => c.replace("$VENV", venv));
    // the hub's own settings (its page password among them) aren't the integrations' business
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PEGAS[IU]S_/.test(k)));
    const env = {
      ...base,
      ...(meta.env || {}),
      UC_CONFIG_HOME: meta.dockerConfigPath ? configLink(id, this.store.configDir(id)) : this.store.configDir(id),
      // integrations installed by hub 0.3+ get their own data folder, like on the remote
      UC_DATA_HOME: meta.ownDataDir ? this.store.dataDirOf(id) : this.store.configDir(id),
      STATE_DIRECTORY: meta.ownDataDir ? this.store.dataDirOf(id) : this.store.configDir(id),
      UC_INTEGRATION_INTERFACE: "127.0.0.1",
      UC_INTEGRATION_HTTP_PORT: String(meta.port),
      UC_DISABLE_MDNS_PUBLISH: "true",
      PYTHONUNBUFFERED: "1",
      ...(meta.pythonPath?.length ? { PYTHONPATH: [...meta.pythonPath.map((p) => path.join(appDir, p)), process.env.PYTHONPATH].filter(Boolean).join(":") } : {}),
      HOME: this.store.configDir(id),
      ...this.extraEnv(id)
    };
    fs.mkdirSync(env.UC_CONFIG_HOME, { recursive: true });
    fs.mkdirSync(env.UC_DATA_HOME, { recursive: true });
    this.#set(id, "starting");
    this.note(id, `starting: ${[cmd, ...args].join(" ")} (port ${meta.port})`);
    let child;
    try {
      // its own process group, so stopping it also stops what it started ("npm start" runs the
      // driver as a child that would otherwise keep running and hold its port)
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      this.note(id, `could not start: ${e.message}`);
      this.#set(id, "error");
      return;
    }
    p.child = child;
    p.startedAt = Date.now();
    const pipe = (stream, kind) => {
      let rest = "";
      stream.on("data", (d) => {
        rest += d.toString();
        const parts = rest.split(/\r?\n/);
        rest = parts.pop();
        for (const l of parts) if (l.trim()) this.#line(id, l, kind);
      });
    };
    pipe(child.stdout, "out");
    pipe(child.stderr, "err");
    child.on("error", (e) => this.note(id, `process error: ${e.message}`));
    child.on("exit", (code, signal) => this.#exited(id, code, signal));
    this.#waitReady(id, child, meta.port);
  }

  async #waitReady(id, child, port) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const p = this.procs.get(id);
      if (!p || p.child !== child) return;
      if (await portOpen(port)) {
        this.#set(id, "running");
        this.note(id, "ready");
        return;
      }
      await sleep(250);
    }
    this.note(id, "did not open its port within 60 s; still waiting");
  }

  #exited(id, code, signal) {
    const p = this.#entry(id);
    const ranFor = Date.now() - (p.startedAt || Date.now());
    p.child = null;
    p.lastExit = { code, signal, at: Date.now() };
    this.note(id, `exited (${signal || `code ${code}`}) after ${Math.round(ranFor / 1000)} s`);
    if (!p.wantRunning) {
      this.#set(id, "stopped");
      return;
    }
    if (ranFor > 120000) p.restarts = 0;
    p.restarts++;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(p.restarts - 1, 6));
    this.#set(id, "crashed");
    this.note(id, `restarting in ${Math.round(delay / 1000)} s`);
    p.timer = setTimeout(async () => {
      if (!p.wantRunning || !this.store.get(id) || p.child) return;
      await this.#ensurePort(id);
      const meta = this.store.get(id);
      if (p.wantRunning && meta && !p.child) this.#spawn(id, meta);
    }, delay);
  }

  async stop(id, { quiet = false } = {}) {
    const p = this.procs.get(id);
    if (!p) return;
    p.wantRunning = false;
    clearTimeout(p.timer);
    const child = p.child;
    if (!child) {
      this.#set(id, "stopped");
      return;
    }
    if (!quiet) this.note(id, "stopping");
    const gone = new Promise((r) => child.once("exit", r));
    killGroup(child, "SIGTERM");
    const t = setTimeout(() => killGroup(child, "SIGKILL"), 5000);
    await gone;
    clearTimeout(t);
  }

  async restart(id) {
    await this.stop(id);
    await this.start(id);
  }

  setState(id, state) {
    this.#set(id, state);
  }

  forget(id) {
    this.procs.delete(id);
  }

  /** Masks secrets in log files written before masking existed (or by an older hub). */
  scrubLogs() {
    let n = 0;
    for (const meta of this.store.list()) {
      for (const f of [this.store.logFile(meta.id), this.store.logFile(meta.id) + ".1"]) {
        try {
          if (!fs.existsSync(f)) continue;
          const before = fs.readFileSync(f, "utf8");
          const after = before.split("\n").map(redact).join("\n");
          if (after !== before) {
            fs.writeFileSync(f + ".tmp", after);
            fs.renameSync(f + ".tmp", f);
            n++;
          }
        } catch {
          /* a log file we can't clean is left for the next start */
        }
      }
    }
    return n;
  }

  async stopAll() {
    clearInterval(this.usageTimer);
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id, { quiet: true })));
  }
}

function readTail(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-LOG_LINES).map(redact);
  } catch {
    return [];
  }
}

/** Signals a driver's whole process group (falls back to the process alone). */
function killGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* gone */
    }
  }
}

/**
 * /config/<id>, a link to the integration's settings folder, for integrations that only see they
 * run in a container when their settings folder is under /config. Falls back to the folder itself
 * when /config can't be used (the container didn't start as root).
 */
function configLink(id, real) {
  const link = path.join("/config", id);
  try {
    if (fs.existsSync(link) && fs.realpathSync(link) === fs.realpathSync(real)) return link;
    fs.rmSync(link, { force: true });
    fs.symlinkSync(real, link);
    return link;
  } catch {
    return real;
  }
}

