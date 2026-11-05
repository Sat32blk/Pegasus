// Network traffic of each integration to its devices and services, for the battery estimate: on
// the remote that traffic would go over its Wi-Fi. Every few seconds the hub lists TCP sockets with
// their byte and packet counters (`ss -tinOHe`, iproute2), matches them to the integrations'
// processes by socket inode, and adds up what changed. Local traffic (127.0.0.1: the link to the
// remote goes that way and is counted separately) is left out. Connections that open and close
// between two looks, and UDP (discovery broadcasts), are missed, so the figure is a lower bound.

import { execFile } from "node:child_process";
import { processTable, descendants, socketInodes } from "./procnet.js";

const EVERY_MS = 10000;

export class NetUsage {
  constructor({ sup, store }) {
    this.sup = sup;
    this.store = store;
    this.since = Date.now();
    this.sockets = new Map(); // inode -> { id, bytes, packets }
    this.totals = new Map(); // id -> { bytes, packets, since }
    this.available = null; // false when `ss` isn't there
    this.timer = setInterval(() => this.sample().catch(() => {}), EVERY_MS);
    this.timer.unref?.();
  }

  async sample() {
    if (this.available === false) return;
    const text = await ss();
    if (text == null) {
      this.available = false;
      return;
    }
    this.available = true;
    const procs = processTable();
    const owner = new Map(); // inode -> integration id
    for (const m of this.store.list()) {
      const pid = this.sup.info(m.id).pid;
      if (!pid) continue;
      for (const p of descendants(procs, pid)) for (const ino of socketInodes(p)) owner.set(ino, m.id);
    }
    const seen = new Set();
    for (const s of parseSs(text)) {
      const id = owner.get(s.ino);
      if (!id || s.local) continue;
      seen.add(s.ino);
      const prev = this.sockets.get(s.ino);
      const db = prev ? Math.max(0, s.bytes - prev.bytes) : s.bytes;
      const dp = prev ? Math.max(0, s.packets - prev.packets) : s.packets;
      this.sockets.set(s.ino, { id, bytes: s.bytes, packets: s.packets });
      let t = this.totals.get(id);
      if (!t) this.totals.set(id, (t = { bytes: 0, packets: 0, since: Date.now() }));
      t.bytes += db;
      t.packets += dp;
    }
    for (const ino of [...this.sockets.keys()]) if (!seen.has(ino)) this.sockets.delete(ino);
  }

  /** { bytesPerSec, packetsPerSec } since the hub started measuring this integration, or null. */
  rate(id) {
    if (!this.available) return null;
    const t = this.totals.get(id);
    const secs = Math.max(60, (Date.now() - (t?.since ?? this.since)) / 1000);
    return { bytesPerSec: (t?.bytes || 0) / secs, packetsPerSec: (t?.packets || 0) / secs };
  }

  close() {
    clearInterval(this.timer);
  }
}

function ss() {
  return new Promise((resolve) => {
    execFile("ss", ["-tinOHe"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
  });
}

/** One entry per TCP socket line of `ss -tinOHe`. */
export function parseSs(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const ino = /\bino:(\d+)/.exec(line)?.[1];
    if (!ino || ino === "0") continue;
    const cols = line.trim().split(/\s+/);
    // State? Recv-Q Send-Q Local Peer ...: the peer is the 4th/5th column
    const addrs = cols.filter((c) => /:\d+$/.test(c) && !/^(ino|sk|uid|rto|ato|mss|pmtu|rcvmss|advmss|cwnd|ssthresh|lastsnd|lastrcv|lastack|delivered|minrtt|rcv_rtt|rcv_space|rcv_ssthresh|snd_wnd)/.test(c));
    const peer = addrs[1] || "";
    const local = /^(127\.|\[::1\]|::1|\[::ffff:127\.)/.test(peer.replace(/^\[?::ffff:/, (m) => m));
    const n = (k) => Number(new RegExp(`\\b${k}:(\\d+)`).exec(line)?.[1] || 0);
    out.push({ ino, local, bytes: n("bytes_sent") + n("bytes_received"), packets: n("data_segs_out") + n("data_segs_in") });
  }
  return out;
}
