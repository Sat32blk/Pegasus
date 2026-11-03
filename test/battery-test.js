// Battery history: storing samples from the Bridge and working out drain figures.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BatteryStore, summarize } from "../hub/src/battery.js";
import { BatteryTracker } from "../bridge/src/bin/battery.js";

const H = 3600e3;
const t0 = Date.now() - 20 * H;
// awake 4 h: 90 → 86 (1 %/h); asleep 8 h: 86 → 84 (0.25 %/h); awake 2 h: 84 → 80 (2 %/h, kept awake);
// charging 2 h: 80 → 95 (ignored); awake 1 h: 95 → 94
const S = [
  { t: t0, event: "start", level: 90 },
  { t: t0 + 2 * H, event: "periodic", level: 88 },
  { t: t0 + 4 * H, event: "standby", level: 86 },
  { t: t0 + 12 * H, event: "start", level: 84, inhibited: true, inhibitors: [{ who: "Activity Watch ShieldTV", why: "prevent sleep", blocking: true }] },
  { t: t0 + 14 * H, event: "periodic", level: 80, inhibited: true, inhibitors: [{ who: "Activity Watch ShieldTV", why: "prevent sleep", blocking: true }] },
  { t: t0 + 15 * H, event: "periodic", level: 88, charging: true },
  { t: t0 + 16 * H, event: "periodic", level: 95, charging: false },
  { t: t0 + 17 * H, event: "periodic", level: 94 }
];
const s = summarize(S);
assert.deepEqual(s.hours, { awake: 7, asleep: 8 });
assert.equal(s.drainPerHour.awake, 1.29); // (4 + 4 + 1) / 7 h
assert.equal(s.drainPerHour.asleep, 0.25);
assert.equal(s.drainPerHour.overall, 0.73); // 11 % / 15 h
assert.equal(s.hoursPerCharge, 136);
assert.equal(s.keptAwakeShare, 0.29); // 2 of 7 awake readings
assert.equal(s.keptAwakeBy[0].who, "Activity Watch ShieldTV (prevent sleep)");
assert.equal(s.last.level, 94);
console.log("  ✓ drain awake / asleep, charging ignored, what kept it awake");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-batt-"));
const store = new BatteryStore(dir);
assert.equal(store.add("Remote3-test.local", S), 8);
assert.equal(store.add("Remote3-test.local", S.slice(-3)), 0, "duplicates added");
assert.equal(new BatteryStore(dir).samples("Remote3-test.local").length, 8, "not saved");
console.log("  ✓ stored per remote, duplicates ignored, survives a restart");

assert.equal(summarize([]).drainPerHour.overall, null);
assert.equal(summarize([{ t: t0, level: 50 }, { t: t0 + 72 * H, level: 40 }]).hours.awake, 0, "used a 3-day gap");
console.log("  ✓ no data and long gaps handled");
{
  const fake = {
    async get(p) {
      if (p === "/system/power/battery") return { capacity: 91, status: "DISCHARGING", power_supply: false };
      if (p === "/system/power") return { mode: "LOW_POWER", power_supply: false, standby_inhibitors: true, standby_timeout_sec: 86400 };
      if (p === "/system/power/standby_inhibitors") return [{ id: "x", who: "Activity Watch ShieldTV", why: "prevent sleep", mode: "BLOCK" }];
      throw new Error("404");
    }
  };
  const file = path.join(dir, "bridge-battery.json");
  const sent = [];
  const tr = new BatteryTracker({ getCore: () => fake, file, onSample: (x) => sent.push(x) });
  const x = await tr.sample("standby");
  assert.deepEqual({ level: x.level, charging: x.charging, mode: x.mode, inhibited: x.inhibited, who: x.inhibitors[0].who, blocking: x.inhibitors[0].blocking }, { level: 91, charging: false, mode: "LOW_POWER", inhibited: true, who: "Activity Watch ShieldTV", blocking: true });
  assert.equal(sent.length, 1);
  assert.equal(tr.pending().length, 1);
  tr.markSent(tr.pending());
  assert.equal(tr.pending().length, 0);
  assert.equal(tr.pending(true).length, 1, "resend after reconnect");
  assert.equal(new BatteryTracker({ getCore: () => fake, file }).samples.length, 1, "Bridge samples not kept");
  console.log("  ✓ Bridge reads battery, power mode and inhibitors; keeps and resends samples");
}
console.log("battery-test: ok");
