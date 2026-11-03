// Battery history per remote (samples sent by the Bridge), and the drain figures shown on the page.

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./util.js";

const KEEP_MS = 90 * 24 * 3600 * 1000;
const H = 3600 * 1000;

export class BatteryStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "remotes");
    this.cache = new Map();
  }

  #file(remote) {
    return path.join(this.dir, String(remote).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80), "battery.json");
  }

  samples(remote) {
    if (!this.cache.has(remote)) this.cache.set(remote, readJson(this.#file(remote), { samples: [] }).samples || []);
    return this.cache.get(remote);
  }

  /** Adds samples (duplicates by time are ignored). */
  add(remote, incoming) {
    const list = this.samples(remote);
    const have = new Set(list.map((s) => s.t));
    let added = 0;
    for (const s of incoming) {
      if (!s || typeof s.t !== "number" || have.has(s.t)) continue;
      list.push(clean(s));
      have.add(s.t);
      added++;
    }
    if (!added) return 0;
    list.sort((a, b) => a.t - b.t);
    const cutoff = Date.now() - KEEP_MS;
    while (list.length && list[0].t < cutoff) list.shift();
    fs.mkdirSync(path.dirname(this.#file(remote)), { recursive: true });
    writeJson(this.#file(remote), { samples: list });
    return added;
  }

  remotes() {
    try {
      return fs.readdirSync(this.dir);
    } catch {
      return [];
    }
  }
}

function clean(s) {
  const out = { t: s.t, event: String(s.event || "periodic").slice(0, 16) };
  if (typeof s.level === "number") out.level = Math.max(0, Math.min(100, s.level));
  if (s.status) out.status = String(s.status).slice(0, 20);
  out.charging = !!s.charging;
  if (s.mode) out.mode = String(s.mode).slice(0, 20);
  if (s.inhibited) out.inhibited = true;
  if (Array.isArray(s.inhibitors)) out.inhibitors = s.inhibitors.slice(0, 8).map((i) => ({ who: String(i.who || "").slice(0, 64), why: String(i.why || "").slice(0, 64), blocking: !!i.blocking }));
  return out;
}

/**
 * Drain figures over [from, to]. A stretch between two samples counts when the remote was on
 * battery at both ends and the level didn't go up (that would mean it charged in between).
 * It counts as "asleep" when the earlier sample was taken going into standby.
 */
export function summarize(samples, { from = 0, to = Infinity } = {}) {
  const s = samples.filter((x) => x.t >= from && x.t <= to && typeof x.level === "number");
  const acc = { awake: { h: 0, drop: 0 }, asleep: { h: 0, drop: 0 } };
  let inhibitedSamples = 0;
  let awakeSamples = 0;
  const who = new Map();
  for (let i = 0; i < s.length; i++) {
    const cur = s[i];
    if (cur.event !== "standby") {
      awakeSamples++;
      if (cur.inhibited) inhibitedSamples++;
      for (const inh of cur.inhibitors || []) {
        const k = inh.who + (inh.why ? ` (${inh.why})` : "");
        who.set(k, (who.get(k) || 0) + 1);
      }
    }
    if (i === 0) continue;
    const prev = s[i - 1];
    const hours = (cur.t - prev.t) / H;
    if (hours <= 0 || hours > 48) continue;
    if (prev.charging || cur.charging) continue;
    const drop = prev.level - cur.level;
    if (drop < 0) continue; // charged in between
    const kind = prev.event === "standby" ? "asleep" : "awake";
    acc[kind].h += hours;
    acc[kind].drop += drop;
  }
  const rate = (a) => (a.h >= 0.5 ? a.drop / a.h : null);
  const totalH = acc.awake.h + acc.asleep.h;
  const totalDrop = acc.awake.drop + acc.asleep.drop;
  const overall = totalH >= 2 ? totalDrop / totalH : null;
  const last = s.at(-1) || null;
  return {
    samples: s.length,
    hours: { awake: round(acc.awake.h, 1), asleep: round(acc.asleep.h, 1) },
    drainPerHour: { awake: round(rate(acc.awake), 2), asleep: round(rate(acc.asleep), 2), overall: round(overall, 2) },
    hoursPerCharge: overall && overall > 0 ? round(100 / overall, 0) : null,
    keptAwakeShare: awakeSamples ? round(inhibitedSamples / awakeSamples, 2) : null,
    keptAwakeBy: [...who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => ({ who: k, samples: n })),
    last: last ? { t: last.t, level: last.level, charging: last.charging, mode: last.mode || null, inhibitors: last.inhibitors || [] } : null
  };
}

const round = (v, d) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
