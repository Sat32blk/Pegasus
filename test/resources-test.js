// Resource history and the battery before/after-moving comparison.
import assert from "node:assert/strict";
import { Resources, batteryComparison, hostInfo } from "../hub/src/resources.js";
import { summarize } from "../hub/src/battery.js";

// ---- battery: 3 days before the move draining 2 %/h awake and 0.5 %/h asleep, 3 days after at 1.5 and 0.3
const H = 3600e3;
const split = Date.UTC(2026, 10, 3, 0, 0);
const samples = [];
let level = 100;
const day = (start, awakeRate, asleepRate) => {
  // each day: 6 h awake (readings hourly), then 18 h asleep (one standby reading, one wake reading)
  for (let d = 0; d < 3; d++) {
    const t0 = start + d * 24 * H;
    level = 100;
    for (let h = 0; h <= 6; h++) samples.push({ t: t0 + h * H, level: (level = 100 - awakeRate * h), event: h === 6 ? "standby" : "periodic" });
    samples.push({ t: t0 + 24 * H - 60000, level: level - asleepRate * (18 - 1 / 60), event: "wake", charging: false });
    samples.push({ t: t0 + 24 * H - 30000, level: 100, event: "periodic", charging: true }); // charged overnight: not counted
  }
};
day(split - 3 * 24 * H, 2, 0.5);
day(split, 1.5, 0.3);
const c = batteryComparison(summarize, samples, split, split + 3 * 24 * H);
assert.equal(c.before.drainPerHour.awake, 2);
assert.equal(c.after.drainPerHour.awake, 1.5);
assert.equal(c.saving.confidence, "good");
assert.equal(c.saving.awakeHoursPerDay, 6);
// per day: 0.5 %/h * 6 h awake + 0.2 %/h * 18 h asleep = 3 + 3.6 = 6.6 %
assert.ok(Math.abs(c.saving.percentPerDay - 6.6) < 0.2, `saving ${c.saving.percentPerDay}`);
assert.ok(c.saving.daysPerChargeAfter > c.saving.daysPerChargeBefore);
console.log(`  ✓ battery: ${c.saving.percentPerDay} %/day saved (${Math.round(c.saving.relative * 100)} %), ${c.saving.daysPerChargeBefore} → ${c.saving.daysPerChargeAfter} days per charge, confidence ${c.saving.confidence}`);
assert.deepEqual(batteryComparison(summarize, samples, null), { split: null, before: null, after: null, saving: null });
const thin = batteryComparison(summarize, samples.filter((x) => x.t < split + 8 * H), split, split + 8 * H);
assert.equal(thin.saving.confidence, "low");
console.log("  ✓ no move yet: nothing claimed; a few hours of data: confidence low");

// ---- resources: integrations, hub, server and the remote (status read only while awake)
const usage = { a: { cpu: 1.5, memMB: 40 }, b: { cpu: 0.5, memMB: 60 } };
const store = { list: () => [{ id: "a", name: "A" }, { id: "b", name: "B" }] };
const sup = { usage: (id) => usage[id], info: () => ({ state: "running" }) };
let asked = 0;
const remotes = [{ remote: "R", address: "10.0.0.9", standby: false }];
const res = new Resources({ sup, store, remotes: () => remotes, fetchStatus: async () => (asked++, { memory: { total_memory: 4096 * 1048576, available_memory: 3072 * 1048576 }, load_avg: { one: 1.2, five: 1, fifteen: 0.8 } }) });
res.sample();
res.sample();
await res.sampleRemotes();
remotes[0].standby = true;
await res.sampleRemotes();
assert.equal(asked, 1, "asleep remote must not be asked");
const snap = res.snapshot();
assert.equal(snap.integrations.length, 2);
assert.equal(snap.integrations[0].history[0].cpu, 1.5);
assert.equal(snap.integrations[1].history[0].memMax, 60);
assert.ok(snap.hub.history[0].mem >= 100, "hub total includes integrations");
assert.equal(snap.remotes[0].last.memUsedMB, 1024);
assert.equal(snap.remotes[0].last.load1, 1.2);
assert.ok(snap.host.memTotalMB > 0 && snap.host.cores >= 1);
assert.ok(hostInfo().memUsedMB > 0);
res.close();
console.log("  ✓ resources: per-integration and hub history, server memory, the remote read only while awake");
console.log("resources-test: ok");
