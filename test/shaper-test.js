// Event shaping: subscriptions, repeats, holding while asleep, delivery on wake, stay connected.
import assert from "node:assert/strict";
import { SessionShaper } from "../hub/src/shaper.js";

const J = (o) => Buffer.from(JSON.stringify(o));
const P = (b) => JSON.parse(b.toString());
const counts = {};
const sh = new SessionShaper({ count: (k, n) => (counts[k] = (counts[k] || 0) + n) });
const change = (id, attributes) => J({ kind: "event", msg: "entity_change", cat: "ENTITY", msg_data: { entity_type: "light", entity_id: id, attributes } });

// before any subscription everything passes
assert.equal(sh.fromDriver(change("tv", { state: "ON" }), false).length, 1);
// the remote subscribes to two entities
assert.ok(sh.fromRemote(J({ kind: "req", id: 1, msg: "subscribe_events", msg_data: { entity_ids: ["tv", "lamp"] } })));
assert.equal(sh.fromDriver(change("kitchen", { state: "ON" }), false).length, 0, "unsubscribed entity dropped");
assert.equal(sh.fromDriver(change("lamp", { state: "ON", brightness: 10 }), false).length, 1);
assert.equal(sh.fromDriver(change("lamp", { state: "ON", brightness: 10 }), false).length, 0, "identical repeat dropped");
assert.equal(sh.fromDriver(change("lamp", { brightness: 20 }), false).length, 1, "a change passes");
console.log("  ✓ updates for unsubscribed entities and identical repeats are dropped; changes pass");

// asleep: held and merged, answers still go at once
assert.equal(sh.fromDriver(change("lamp", { brightness: 30 }), true).length, 0);
assert.equal(sh.fromDriver(change("lamp", { state: "OFF" }), true).length, 0);
assert.equal(sh.fromDriver(change("tv", { media_position: 10 }), true).length, 0);
assert.equal(sh.fromDriver(change("tv", { media_position: 11 }), true).length, 0);
assert.equal(sh.fromDriver(J({ kind: "event", msg: "device_state", msg_data: { state: "CONNECTING" } }), true).length, 0);
assert.equal(sh.fromDriver(J({ kind: "event", msg: "device_state", msg_data: { state: "CONNECTED" } }), true).length, 0);
const resp = sh.fromDriver(J({ kind: "resp", req_id: 5, code: 200, msg: "result" }), true);
assert.equal(resp.length, 1, "answers are never held");
assert.ok(sh.hasHeld());
const woke = sh.flush().map(P);
assert.deepEqual(woke.map((m) => m.msg), ["device_state", "entity_change", "entity_change"]);
assert.equal(woke[0].msg_data.state, "CONNECTED", "newest device state only");
assert.deepEqual(woke.find((m) => m.msg_data.entity_id === "lamp").msg_data.attributes, { brightness: 30, state: "OFF" }, "attributes merged");
assert.deepEqual(woke.find((m) => m.msg_data.entity_id === "tv").msg_data.attributes, { media_position: 11 });
assert.equal(counts.merged, 3);
assert.ok(!sh.hasHeld());
console.log(`  ✓ asleep: 6 events became 3 on wake (newest device state, attributes merged); answers not held`);

// held and back where it started: nothing to send
sh.fromDriver(change("lamp", { brightness: 99 }), true);
sh.fromDriver(change("lamp", { brightness: 30, state: "OFF" }), true);
// last sent for lamp was {brightness:30,state:OFF} (merged on wake) -> merged held is identical -> nothing
assert.equal(sh.flush().length, 0, "ended where it started");
// awake again with something held: it goes first, then the new message
sh.fromDriver(change("tv", { state: "OFF" }), true);
const order = sh.fromDriver(change("lamp", { state: "ON" }), false).map(P);
assert.deepEqual(order.map((m) => m.msg_data.entity_id), ["tv", "lamp"]);
console.log("  ✓ an entity that ends where it started sends nothing; held updates go before new ones");

// re-subscribing / asking for states lets the current state through again
sh.fromRemote(J({ kind: "req", id: 9, msg: "get_entity_states" }));
assert.equal(sh.fromDriver(change("lamp", { state: "ON" }), false).length, 1);
sh.fromRemote(J({ kind: "req", id: 10, msg: "unsubscribe_events", msg_data: { entity_ids: ["lamp"] } }));
assert.equal(sh.fromDriver(change("lamp", { state: "OFF" }), false).length, 0);
console.log("  ✓ get_entity_states and subscriptions reset what counts as a repeat; unsubscribing filters");

// stay connected: standby events from the remote are not passed on (only when switched on)
const enter = J({ kind: "event", msg: "enter_standby", cat: "REMOTE" });
assert.ok(sh.fromRemote(enter), "passed by default");
let keep = true;
const sh2 = new SessionShaper({ keepConnected: () => keep });
assert.equal(sh2.fromRemote(enter), null);
keep = false;
assert.ok(sh2.fromRemote(enter));
// binary, huge and non-JSON pass untouched
const big = Buffer.alloc(300 * 1024, 0x7b);
assert.equal(sh.fromDriver(big, true)[0], big);
assert.equal(sh.fromDriver(Buffer.from("not json"), false).length, 1);
console.log("  ✓ stay connected hides standby from the integration; large or non-JSON messages pass untouched");
console.log("shaper-test: ok");
