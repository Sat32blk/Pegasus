// Network statistics: counting, request/response pairing, round trip and link history.
import assert from "node:assert/strict";
import { NetStats } from "../hub/src/netstats.js";

const n = new NetStats();
const B = (s) => Buffer.from(s);
n.linkUp("Living Room");
n.frame("Living Room", "in", 100);
n.frame("Living Room", "out", 300);
for (const ms of [2, 3, 4, 5, 50]) n.rtt("Living Room", ms);

// remote -> driver request, driver answers; the same id on another channel must not mix
n.message("tv", 1, "in", B('{"kind":"req","id":7,"msg":"entity_command","msg_data":{}}'), true);
n.message("tv", 2, "in", B('{"kind":"req","id":7,"msg":"get_entity_states"}'), true);
await new Promise((r) => setTimeout(r, 30));
n.message("tv", 1, "out", B('{"kind":"resp","req_id":7,"code":200,"msg":"result"}'), true);
n.message("tv", 1, "out", B('{"kind":"event","msg":"entity_change","msg_data":{}}'), true);
n.message("tv", 1, "out", Buffer.alloc(10), false); // binary: counted, not parsed
// answer with no request, and a huge message: ignored for timing, counted for traffic
n.message("tv", 1, "out", B('{"kind":"resp","req_id":99}'), true);
n.message("tv", 1, "in", Buffer.alloc(10000, 32), true);

const snap = n.snapshot({ "Living Room": { rttMs: 3.3, sessions: 2, address: "a", bridge: "0.3.3" } }, { tv: "Samsung TV" });
const r = snap.remotes[0];
assert.equal(r.connected, true);
assert.equal(r.totals.bytesIn, 100);
assert.equal(r.totals.bytesOut, 300);
assert.equal(r.rtt.now, 3.3);
assert.equal(r.rtt.min, 2);
assert.equal(r.rtt.max, 50);
assert.equal(r.rtt.median, 4);
assert.equal(r.history.length, 1);
assert.ok(r.history[0].rtt > 10 && r.history[0].rtt < 13);
assert.ok(r.rate.inBps > 0 && r.rate.msgsPerMin > 0);
console.log("  ✓ remote: traffic, round trip (min / median / max), per-minute history and rates");

const t = snap.integrations[0];
assert.equal(t.name, "Samsung TV");
assert.equal(t.requests, 2);
assert.equal(t.events, 1);
assert.equal(t.response.n, 1, "only the answered request is timed");
assert.ok(t.response.median >= 25 && t.response.median < 500, `response ${t.response.median}`);
assert.equal(t.response.slowest.msg, "entity_command");
assert.equal(t.totals.msgsIn, 3);
assert.equal(t.totals.msgsOut, 4);
console.log("  ✓ integration: requests paired with answers per channel, events, binary and large messages counted only");

n.linkDown("Living Room");
n.linkUp("Living Room");
const s2 = n.snapshot({}, {});
assert.equal(s2.remotes[0].reconnects, 1);
assert.equal(s2.remotes[0].connected, false);
assert.equal(s2.remotes[0].history[0].down, true);
n.forget("tv");
assert.equal(n.snapshot().integrations.length, 0);
console.log("  ✓ reconnects counted, drops marked in the history, removed integrations forgotten");
console.log("netstats-test: ok");
