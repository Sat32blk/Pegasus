// Keeps each hosted integration driver running as a child process, listening on its own port on
// 127.0.0.1 inside the container. Restarts crashed drivers with backoff and keeps their logs.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { portOpen, sleep } from "./util.js";
import { redact } from "./redact.js";

const LOG_LINES = 800;
const LOG_FILE_MAX = 2 * 1024 * 1024;

export class Supervisor extends EventEmitter {
  constructor({ store, log }) {
    super();
    this.store = store;
    this.log = log;
    this.procs = new Map(); // id -> { child, state, since, restarts, timer, wantRunning, lines, startedAt, lastExit }
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
    this.#spawn(id, meta);
  }

  #spawn(id, meta) {
    const p = this.#entry(id);
    const appDir = this.store.appDir(id);
    const cwd = path.join(appDir, meta.cwd || "");
    const venv = path.join(appDir, ".venv");
    const [cmd, ...args] = meta.command.map((c) => c.replace("$VENV", venv));
    const env = {
      ...process.env,
      ...(meta.env || {}),
      UC_CONFIG_HOME: this.store.configDir(id),
      // integrations installed by hub 0.3+ get their own data folder, like on the remote
      UC_DATA_HOME: meta.ownDataDir ? this.store.dataDirOf(id) : this.store.configDir(id),
      STATE_DIRECTORY: meta.ownDataDir ? this.store.dataDirOf(id) : this.store.configDir(id),
      UC_INTEGRATION_INTERFACE: "127.0.0.1",
      UC_INTEGRATION_HTTP_PORT: String(meta.port),
      UC_DISABLE_MDNS_PUBLISH: "true",
      PYTHONUNBUFFERED: "1",
      ...(meta.pythonPath?.length ? { PYTHONPATH: [...meta.pythonPath.map((p) => path.join(appDir, p)), process.env.PYTHONPATH].filter(Boolean).join(":") } : {}),
      HOME: this.store.configDir(id)
    };
    fs.mkdirSync(env.UC_CONFIG_HOME, { recursive: true });
    fs.mkdirSync(env.UC_DATA_HOME, { recursive: true });
    this.#set(id, "starting");
    this.note(id, `starting: ${[cmd, ...args].join(" ")} (port ${meta.port})`);
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    p.timer = setTimeout(() => {
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
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 5000);
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
