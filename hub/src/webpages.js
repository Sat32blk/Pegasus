// Integrations with a management page of their own (e.g. Remote Self-Control's builder on port
// 10123): the hub looks at which TCP ports each integration's processes listen on (Linux /proc),
// leaves out the port the remote talks to, and keeps those that answer a browser with a web page.
// Only ports open to the network count (not ones bound to 127.0.0.1, which a browser can't reach).

import fs from "node:fs";

const EVERY_MS = 30000;
const PROBE_MS = 2000;

export class WebPages {
  /** sup: the supervisor (info(id).pid); store: list() of integrations (id, port) */
  constructor({ sup, store }) {
    this.sup = sup;
    this.store = store;
    this.found = new Map(); // id -> [{ port, path }]
    this.timer = setInterval(() => this.scan().catch(() => {}), EVERY_MS);
    this.timer.unref?.();
    setTimeout(() => this.scan().catch(() => {}), 5000).unref?.();
    sup.on?.("change", (id, state) => {
      if (state === "running") setTimeout(() => this.scan([id]).catch(() => {}), 4000).unref?.();
      else if (state !== "starting") this.found.delete(id);
    });
  }

  /** [{ port, path }] for one integration (empty when it has no page). */
  of(id) {
    return this.found.get(id) || [];
  }

  async scan(ids = null) {
    if (!fs.existsSync("/proc/net/tcp")) return;
    const listening = listeningSockets();
    const procs = processTable();
    for (const m of this.store.list()) {
      if (ids && !ids.includes(m.id)) continue;
      const pid = this.sup.info(m.id).pid;
      if (!pid) {
        this.found.delete(m.id);
        continue;
      }
      const ports = new Set();
      for (const p of descendants(procs, pid)) {
        for (const inode of socketInodes(p)) {
          const l = listening.get(inode);
          if (l && l.port !== m.port && l.open) ports.add(l.port);
        }
      }
      const pages = [];
      for (const port of [...ports].sort((a, b) => a - b).slice(0, 6)) {
        if (await isWebPage(port)) pages.push({ port, path: "/" });
      }
      this.found.set(m.id, pages);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

/** inode -> { port, open } for every listening TCP socket (open = reachable from the network). */
function listeningSockets() {
  const out = new Map();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10 || c[3] !== "0A") continue; // 0A = LISTEN
      const [addr, portHex] = c[1].split(":");
      const loopback = /^0100007F$/i.test(addr) || /^0{24}01000000$/i.test(addr) || /^0{20}FFFF00000100007F$/i.test(addr);
      out.set(c[9], { port: parseInt(portHex, 16), open: !loopback });
    }
  }
  return out;
}

/** pid -> parent pid, for every process. */
function processTable() {
  const parent = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
      parent.set(Number(d), ppid);
    } catch {
      /* gone */
    }
  }
  return parent;
}

function descendants(parent, root) {
  const out = [root];
  for (let i = 0; i < out.length && out.length < 64; i++) for (const [pid, pp] of parent) if (pp === out[i]) out.push(pid);
  return out;
}

function socketInodes(pid) {
  const out = [];
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) out.push(m[1]);
      } catch {
        /* closed meanwhile */
      }
    }
  } catch {
    /* not ours to read, or gone */
  }
  return out;
}

/** A browser gets a web page there (HTML, following redirects). */
async function isWebPage(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(PROBE_MS), headers: { Accept: "text/html" } });
    const type = r.headers.get("content-type") || "";
    await r.body?.cancel().catch(() => {});
    return r.status < 500 && /text\/html|application\/xhtml/i.test(type);
  } catch {
    return false;
  }
}
