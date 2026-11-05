// Small readers of Linux /proc: processes, their children and the sockets they hold.

import fs from "node:fs";

/** inode -> { port, open } for every listening TCP socket (open = reachable from the network). */
export function listeningSockets() {
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
export function processTable() {
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

export function descendants(parent, root) {
  const out = [root];
  for (let i = 0; i < out.length && out.length < 64; i++) for (const [pid, pp] of parent) if (pp === out[i]) out.push(pid);
  return out;
}

export function socketInodes(pid) {
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
