// Network statistics for the hub page: traffic and round trip per remote, traffic and response
// time per integration. Counting is a few additions per frame; the only parsing is a quick look at
// small text messages to pair the remote's requests with the driver's answers (response time).

const MINUTES = 24 * 60; // per-minute history kept for each remote
const RESP_KEEP = 300; // response times kept per integration (for median / 95th percentile)
const MAX_PENDING = 500;

const newTraffic = () => ({ bytesIn: 0, bytesOut: 0, msgsIn: 0, msgsOut: 0 });

export class NetStats {
  constructor() {
    this.remotes = new Map(); // remote name -> { connects, since, lastDown, totals, minutes: [], cur, rttRecent: [] }
    this.intg = new Map(); // hub integration id -> { totals, requests, events, resp: [], last, sessionsOpened, openFailed }
  }

  #remote(name) {
    let r = this.remotes.get(name);
    if (!r) {
      r = { connects: 0, since: null, lastDown: null, totals: newTraffic(), minutes: [], cur: null, rttRecent: [] };
      this.remotes.set(name, r);
    }
    return r;
  }

  #minute(r, now = Date.now()) {
    const m = Math.floor(now / 60000) * 60000;
    if (!r.cur || r.cur.t !== m) {
      if (r.cur) r.minutes.push(r.cur);
      if (r.minutes.length > MINUTES) r.minutes.splice(0, r.minutes.length - MINUTES);
      r.cur = { t: m, ...newTraffic(), rttN: 0, rttSum: 0, rttMax: null, rttMin: null, down: false };
    }
    return r.cur;
  }

  #intg(id) {
    let s = this.intg.get(id);
    if (!s) {
      s = { totals: newTraffic(), requests: 0, events: 0, resp: [], lastActive: null, sessionsOpened: 0, openFailed: 0, pending: new Map() };
      this.intg.set(id, s);
    }
    return s;
  }

  linkUp(remote) {
    const r = this.#remote(remote);
    r.connects++;
    r.since = Date.now();
  }

  linkDown(remote) {
    const r = this.#remote(remote);
    r.lastDown = Date.now();
    r.since = null;
    this.#minute(r).down = true;
  }

  /** Every frame on a link: dir "in" = from the remote, "out" = to the remote. */
  frame(remote, dir, bytes) {
    const r = this.#remote(remote);
    const m = this.#minute(r);
    if (dir === "in") {
      r.totals.bytesIn += bytes;
      r.totals.msgsIn++;
      m.bytesIn += bytes;
      m.msgsIn++;
    } else {
      r.totals.bytesOut += bytes;
      r.totals.msgsOut++;
      m.bytesOut += bytes;
      m.msgsOut++;
    }
  }

  rtt(remote, ms) {
    const r = this.#remote(remote);
    const m = this.#minute(r);
    m.rttN++;
    m.rttSum += ms;
    m.rttMax = m.rttMax == null ? ms : Math.max(m.rttMax, ms);
    m.rttMin = m.rttMin == null ? ms : Math.min(m.rttMin, ms);
    r.rttRecent.push(ms);
    if (r.rttRecent.length > 200) r.rttRecent.shift();
  }

  sessionOpened(id) {
    this.#intg(id).sessionsOpened++;
  }
  sessionFailed(id) {
    this.#intg(id).openFailed++;
  }

  /** Integration API traffic of one session. dir "in" = remote -> driver, "out" = driver -> remote. */
  message(id, channelKey, dir, payload, isText) {
    const s = this.#intg(id);
    const now = Date.now();
    s.lastActive = now;
    if (dir === "in") {
      s.totals.bytesIn += payload.length;
      s.totals.msgsIn++;
    } else {
      s.totals.bytesOut += payload.length;
      s.totals.msgsOut++;
    }
    if (!isText || payload.length > 4096) return;
    // the envelope fields come first in practice; a regex on the start avoids parsing big payloads
    const head = payload.subarray(0, 200).toString("utf8");
    const kind = /"kind"\s*:\s*"(\w+)"/.exec(head)?.[1];
    if (dir === "in" && kind === "req") {
      const id_ = /"id"\s*:\s*(\d+)/.exec(head)?.[1];
      if (id_ == null) return;
      s.requests++;
      if (s.pending.size > MAX_PENDING) s.pending.clear();
      s.pending.set(`${channelKey}:${id_}`, { t: performance.now(), msg: /"msg"\s*:\s*"([\w.]+)"/.exec(head)?.[1] || "" });
    } else if (dir === "out" && kind === "resp") {
      const rid = /"req_id"\s*:\s*(\d+)/.exec(head)?.[1];
      const key = `${channelKey}:${rid}`;
      const p = rid != null && s.pending.get(key);
      if (!p) return;
      s.pending.delete(key);
      const ms = performance.now() - p.t;
      s.resp.push({ ms, msg: p.msg, t: now });
      if (s.resp.length > RESP_KEEP) s.resp.shift();
    } else if (dir === "out" && kind === "event") {
      s.events++;
    }
  }

  /** Summary for the page. live: { remote -> { rttMs, standby, sessions, address, bridge } } */
  snapshot(live = {}, names = {}) {
    const now = Date.now();
    const remotes = [...this.remotes.entries()].map(([name, r]) => {
      const mins = [...r.minutes, ...(r.cur ? [r.cur] : [])].filter((m) => now - m.t <= MINUTES * 60000);
      const last5 = mins.filter((m) => now - m.t < 5 * 60000);
      const span = Math.max(60, Math.min(300, (now - (last5[0]?.t ?? now)) / 1000));
      const sum = (arr, k) => arr.reduce((a, m) => a + m[k], 0);
      const rs = [...r.rttRecent].sort((a, b) => a - b);
      const l = live[name] || null;
      return {
        remote: name,
        connected: !!l,
        since: r.since,
        lastDown: r.lastDown,
        reconnects: Math.max(0, r.connects - 1),
        address: l?.address || null,
        bridge: l?.bridge || null,
        standby: !!l?.standby,
        sessions: l?.sessions ?? 0,
        rtt: {
          now: l?.rttMs ?? null,
          min: rs.length ? rs[0] : null,
          median: pct(rs, 0.5),
          p95: pct(rs, 0.95),
          max: rs.length ? rs[rs.length - 1] : null
        },
        totals: r.totals,
        rate: { inBps: sum(last5, "bytesIn") / span, outBps: sum(last5, "bytesOut") / span, msgsPerMin: ((sum(last5, "msgsIn") + sum(last5, "msgsOut")) / span) * 60 },
        history: mins.map((m) => ({ t: m.t, bytesIn: m.bytesIn, bytesOut: m.bytesOut, msgs: m.msgsIn + m.msgsOut, rtt: m.rttN ? m.rttSum / m.rttN : null, rttMax: m.rttMax, down: m.down }))
      };
    });
    const integrations = [...this.intg.entries()].map(([id, s]) => {
      const ms = s.resp.map((x) => x.ms).sort((a, b) => a - b);
      const slowest = [...s.resp].sort((a, b) => b.ms - a.ms)[0] || null;
      return {
        id,
        name: names[id] || id,
        totals: s.totals,
        requests: s.requests,
        events: s.events,
        sessionsOpened: s.sessionsOpened,
        openFailed: s.openFailed,
        lastActive: s.lastActive,
        response: { n: ms.length, median: pct(ms, 0.5), p95: pct(ms, 0.95), slowest: slowest && { ms: slowest.ms, msg: slowest.msg, t: slowest.t } }
      };
    });
    return { now, remotes, integrations };
  }

  forget(id) {
    this.intg.delete(id);
  }
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
