// Battery tracker: records the remote's battery level and what keeps it awake, so the hub can show
// drain per hour (awake vs asleep) before and after integrations move off the remote.
//
// The Bridge only runs while the remote is awake, so it samples every 10 minutes while awake, plus
// once right before standby and once right after waking (the pair measures drain while asleep).
// Samples are kept on the remote (30 days) and sent to the hub, which keeps its own copy.

import fs from "node:fs";

const EVERY_MS = 10 * 60 * 1000;
const KEEP_MS = 30 * 24 * 3600 * 1000;

export class BatteryTracker {
  constructor({ getCore, file, log = () => {}, onSample = () => {} }) {
    this.getCore = getCore;
    this.file = file;
    this.log = log;
    this.onSample = onSample;
    this.samples = [];
    this.sent = 0; // time of the newest sample the hub has
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      this.samples = Array.isArray(j.samples) ? j.samples : [];
    } catch {
      /* first run */
    }
  }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.sample("periodic"), EVERY_MS);
    this.timer.unref?.();
    this.sample("start");
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Reads battery, power mode and standby inhibitors. event: periodic | start | standby | wake */
  async sample(event) {
    const core = this.getCore();
    if (!core) return null;
    const s = { t: Date.now(), event };
    try {
      const b = await core.get("/system/power/battery");
      s.level = typeof b?.capacity === "number" ? b.capacity : null;
      s.status = b?.status || null;
      s.charging = !!b?.power_supply;
    } catch (e) {
      this.log(`battery: couldn't read it: ${e.message}`);
      return null;
    }
    try {
      const p = await core.get("/system/power");
      s.mode = p?.mode || null;
      if (typeof p?.power_supply === "boolean") s.charging = s.charging || p.power_supply;
      s.inhibited = !!p?.standby_inhibitors;
    } catch {
      /* optional */
    }
    if (s.inhibited) {
      try {
        const list = await core.get("/system/power/standby_inhibitors");
        s.inhibitors = (Array.isArray(list) ? list : []).slice(0, 8).map((i) => ({ who: String(i.who || "").slice(0, 64), why: String(i.why || "").slice(0, 64), blocking: !i.delay }));
      } catch {
        /* optional */
      }
    }
    this.samples.push(s);
    const cutoff = Date.now() - KEEP_MS;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    this.#save();
    this.onSample(s);
    return s;
  }

  #save() {
    try {
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ samples: this.samples }));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch (e) {
      this.log(`battery: couldn't save samples: ${e.message}`);
    }
  }

  /**
   * Samples the hub doesn't have yet. After a reconnect (resend): those newer than hubHas, the time
   * of the newest one the hub says it has; without that, all of the last 2 days (the hub ignores
   * duplicates). Never more than 30 days back.
   */
  pending(resend = false, hubHas = undefined) {
    let from = this.sent;
    if (resend) from = typeof hubHas === "number" && hubHas >= 0 ? Math.min(hubHas, Date.now()) : Date.now() - 2 * 24 * 3600 * 1000;
    return this.samples.filter((s) => s.t > from);
  }

  markSent(samples) {
    for (const s of samples) if (s.t > this.sent) this.sent = s.t;
  }
}
