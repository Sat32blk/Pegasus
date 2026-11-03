// CPU and memory over time, for the hub page: each integration on the hub, the hub itself, the
// server it runs on, and each linked remote (its own /api/pub/status, read only while it's awake so
// its Wi-Fi isn't woken for this). Per-minute history for a day.

import fs from "node:fs";
import os from "node:os";

const MINUTES = 24 * 60;
const SAMPLE_MS = 10000;
const REMOTE_MS = 60000;

/** Per-minute aggregation of a few numeric fields: avg and max of each. */
class Series {
  constructor() {
    this.minutes = [];
    this.cur = null;
  }
  add(values, now = Date.now()) {
    const t = Math.floor(now / 60000) * 60000;
    if (!this.cur || this.cur.t !== t) {
      if (this.cur) this.minutes.push(this.#close(this.cur));
      if (this.minutes.length > MINUTES) this.minutes.splice(0, this.minutes.length - MINUTES);
      this.cur = { t, n: 0, sum: {}, max: {} };
    }
    const c = this.cur;
    c.n++;
    for (const [k, v] of Object.entries(values)) {
      if (v == null || !isFinite(v)) continue;
      c.sum[k] = (c.sum[k] || 0) + v;
      c.max[k] = Math.max(c.max[k] ?? -Infinity, v);
    }
  }
  #close(c) {
    const out = { t: c.t };
    for (const k of Object.keys(c.sum)) {
      out[k] = round(c.sum[k] / c.n, 2);
      out[k + "Max"] = round(c.max[k], 2);
    }
    return out;
  }
  history(now = Date.now()) {
    return [...this.minutes, ...(this.cur ? [this.#close(this.cur)] : [])].filter((m) => now - m.t <= MINUTES * 60000);
  }
}

export class Resources {
  /** remotes(): [{ remote, address, standby }] of linked remotes */
  constructor({ sup, store, remotes, fetchStatus = fetchRemoteStatus }) {
    this.sup = sup;
    this.store = store;
    this.remotes = remotes;
    this.fetchStatus = fetchStatus;
    this.intg = new Map(); // id -> Series
    this.hub = new Series();
    this.host = new Series();
    this.remote = new Map(); // remote name -> { series, last, at, error }
    this.lastCpu = { usage: process.cpuUsage(), at: Date.now() };
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref?.();
    this.remoteTimer = setInterval(() => this.sampleRemotes(), REMOTE_MS);
    this.remoteTimer.unref?.();
    setTimeout(() => this.sampleRemotes(), 5000).unref?.();
  }

  sample(now = Date.now()) {
    let cpuSum = 0;
    let memSum = 0;
    for (const m of this.store.list()) {
      const u = this.sup.usage(m.id);
      if (!u) continue;
      let s = this.intg.get(m.id);
      if (!s) this.intg.set(m.id, (s = new Series()));
      s.add({ cpu: u.cpu, mem: u.memMB }, now);
      cpuSum += u.cpu || 0;
      memSum += u.memMB || 0;
    }
    const usage = process.cpuUsage();
    const dt = (now - this.lastCpu.at) / 1000;
    const hubCpu = dt > 0 ? ((usage.user - this.lastCpu.usage.user + usage.system - this.lastCpu.usage.system) / 1e6 / dt) * 100 : 0;
    this.lastCpu = { usage, at: now };
    const hubMem = process.memoryUsage().rss / 1048576;
    this.hub.add({ cpu: hubCpu + cpuSum, mem: hubMem + memSum, hubCpu, hubMem }, now);
    const h = hostInfo();
    this.host.add({ load: h.load1, memUsed: h.memUsedMB }, now);
  }

  async sampleRemotes() {
    for (const r of this.remotes()) {
      let e = this.remote.get(r.remote);
      if (!e) this.remote.set(r.remote, (e = { series: new Series(), last: null, at: null, error: null }));
      if (r.standby || !r.address) continue; // don't wake the remote for this
      try {
        const st = await this.fetchStatus(r.address);
        const mem = st?.memory || {};
        const total = mem.total_memory / 1048576;
        const used = mem.used_memory != null ? mem.used_memory / 1048576 : mem.available_memory != null ? total - mem.available_memory / 1048576 : null;
        e.last = { memTotalMB: round(total, 0), memUsedMB: round(used, 0), load1: st?.load_avg?.one ?? null, load5: st?.load_avg?.five ?? null, load15: st?.load_avg?.fifteen ?? null, diskFreeMB: st?.filesystem?.user_data?.available != null ? round(st.filesystem.user_data.available / 1048576, 0) : null };
        e.at = Date.now();
        e.error = null;
        e.series.add({ load: e.last.load1, memUsed: e.last.memUsedMB });
      } catch (err) {
        e.error = err.message;
      }
    }
  }

  forget(id) {
    this.intg.delete(id);
  }

  snapshot() {
    const now = Date.now();
    const h = hostInfo();
    return {
      now,
      host: { ...h, history: this.host.history(now) },
      hub: { history: this.hub.history(now), memMB: round(process.memoryUsage().rss / 1048576, 0) },
      integrations: this.store.list().map((m) => {
        const hist = this.intg.get(m.id)?.history(now) || [];
        const hour = hist.filter((x) => now - x.t <= 3600e3);
        return {
          id: m.id,
          name: m.name,
          state: this.sup.info(m.id).state,
          now: this.sup.usage(m.id),
          hour: hour.length ? { cpu: round(hour.reduce((a, x) => a + (x.cpu || 0), 0) / hour.length, 2), cpuMax: round(Math.max(...hour.map((x) => x.cpuMax || 0)), 1), memMax: round(Math.max(...hour.map((x) => x.memMax || 0)), 0) } : null,
          history: hist
        };
      }),
      remotes: [...this.remote.entries()].map(([name, e]) => ({ remote: name, last: e.last, at: e.at, error: e.error, history: e.series.history(now) }))
    };
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.remoteTimer);
  }
}

/** The server as the container sees it (Linux /proc; os module elsewhere). */
export function hostInfo() {
  const cores = os.cpus()?.length || 1;
  let load1 = os.loadavg()[0];
  let memTotalMB = os.totalmem() / 1048576;
  let memAvailMB = os.freemem() / 1048576;
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(mi)?.[1]) / 1024;
    if (kb("MemTotal")) memTotalMB = kb("MemTotal");
    if (kb("MemAvailable")) memAvailMB = kb("MemAvailable");
  } catch {
    /* not Linux */
  }
  return { cores, load1: round(load1, 2), memTotalMB: round(memTotalMB, 0), memUsedMB: round(memTotalMB - memAvailMB, 0) };
}

async function fetchRemoteStatus(address) {
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  const r = await fetch(`http://${host}/api/pub/status`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Battery before and after moving integrations to the hub: drain rates on each side of `split`,
 * and what the difference comes to per day, weighted by how many hours a day the remote is awake.
 */
export function batteryComparison(summarize, samples, split, now = Date.now()) {
  if (!split) return { split: null, before: null, after: null, saving: null };
  const before = summarize(samples, { from: split - 30 * 864e5, to: split });
  const after = summarize(samples, { from: split, to: now });
  const hours = (s) => (s.hours.awake || 0) + (s.hours.asleep || 0);
  const a = before.drainPerHour, b = after.drainPerHour;
  let saving = null;
  if (a.awake != null && b.awake != null) {
    // the share of the day spent awake, from all the readings we have
    const all = summarize(samples, { from: 0, to: now });
    const tot = (all.hours.awake || 0) + (all.hours.asleep || 0);
    const awakeShare = tot > 0 ? all.hours.awake / tot : 0.25;
    const asleepDiff = a.asleep != null && b.asleep != null ? a.asleep - b.asleep : 0;
    const perDay = (a.awake - b.awake) * 24 * awakeShare + asleepDiff * 24 * (1 - awakeShare);
    const dayBefore = a.awake * 24 * awakeShare + (a.asleep ?? 0) * 24 * (1 - awakeShare);
    const dayAfter = b.awake * 24 * awakeShare + (b.asleep ?? 0) * 24 * (1 - awakeShare);
    const minH = Math.min(hours(before), hours(after));
    saving = {
      percentPerDay: round(perDay, 1),
      relative: dayBefore > 0 ? round(perDay / dayBefore, 2) : null,
      daysPerChargeBefore: dayBefore > 0 ? round(100 / dayBefore, 1) : null,
      daysPerChargeAfter: dayAfter > 0 ? round(100 / dayAfter, 1) : null,
      awakeHoursPerDay: round(24 * awakeShare, 1),
      confidence: minH >= 72 ? "good" : minH >= 24 ? "fair" : "low",
      hoursBefore: round(hours(before), 1),
      hoursAfter: round(hours(after), 1)
    };
  }
  return { split, before, after, saving };
}

const round = (v, d) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
