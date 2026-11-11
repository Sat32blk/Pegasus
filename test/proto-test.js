import assert from "node:assert/strict";
import fs from "node:fs";
import { pingRtt, isChannelFrame, SendWindow, T, encode, decode, encodeClose, decodeClose, remoteDriverId, safeCloseCode, pingPayload, pingTime } from "../shared/linkproto.js";

// copies in sync
const src = fs.readFileSync(new URL("../shared/linkproto.js", import.meta.url), "utf8");
for (const p of ["../bridge/src/bin/linkproto.js", "../hub/src/linkproto.js"]) {
  assert.equal(fs.readFileSync(new URL(p, import.meta.url), "utf8"), src, `${p} differs from shared/linkproto.js: run npm run sync-proto`);
}

const f = decode(encode(T.TEXT, 0xdeadbeef, '{"kind":"req"}'));
assert.equal(f.type, T.TEXT);
assert.equal(f.channel, 0xdeadbeef);
assert.equal(f.payload.toString(), '{"kind":"req"}');
assert.equal(decode(Buffer.from([1, 2])), null);
const e = decode(encode(T.OPENED, 7));
assert.equal(e.payload.length, 0);
const c = decodeClose(decode(encodeClose(3, 1012, "restarting")).payload);
assert.deepEqual(c, { code: 1012, reason: "restarting" });
assert.equal(remoteDriverId("sim_node"), "pgs_sim_node");
assert.equal(remoteDriverId("a.b c"), "pgs_a_b_c");
assert.equal(remoteDriverId("x".repeat(60)).length, 36);
assert.equal(safeCloseCode(1006), 1000);
assert.equal(safeCloseCode(1012), 1012);
assert.equal(safeCloseCode(4001), 4001);
assert.equal(pingTime(pingPayload(123.5)), 123.5);
// the Bridge tells its last round trip along with a ping; plain pings carry none
assert.equal(pingRtt(pingPayload(1, 4.25)), 4.25);
assert.ok(Number.isNaN(pingRtt(pingPayload(1))));
assert.equal(pingTime(pingPayload(9, 4.25)), 9);
assert.ok(isChannelFrame(T.TEXT) && isChannelFrame(T.OPEN) && isChannelFrame(T.CLOSE) && !isChannelFrame(T.PING) && !isChannelFrame(T.RPC) && !isChannelFrame(T.STATUS));
// resume: the frames sent, numbered; what the other end missed can be sent again while it's kept
{
  const w = new SendWindow({ maxFrames: 3, maxBytes: 100 });
  assert.ok(w.covers(0) && !w.covers(1));
  for (const x of ["a", "b", "c"]) w.push(Buffer.from(x));
  assert.deepEqual(w.after(1).map(String), ["b", "c"]);
  assert.deepEqual(w.after(3), []);
  assert.ok(w.covers(0) && w.covers(3) && !w.covers(4) && !w.covers(-1) && !w.covers(1.5));
  w.push(Buffer.from("d")); // "a" is gone now
  assert.ok(!w.covers(0) && w.covers(1));
  assert.deepEqual(w.after(1).map(String), ["b", "c", "d"]);
  w.push(Buffer.alloc(100)); // too many bytes: only the newest stays
  assert.equal(w.frames.length, 1);
  assert.ok(!w.covers(3) && w.covers(4) && w.covers(5));
}
console.log("proto-test: ok");
