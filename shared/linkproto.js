// Pegasis link protocol: one persistent WebSocket between the Bridge (on the remote) and the Hub
// (Docker container), carrying any number of integration-driver sessions side by side.
//
// Every WebSocket message on the link is ONE binary frame:
//
//   byte 0      frame type (T.*)
//   bytes 1-4   channel id, unsigned 32-bit big endian (0 = control channel)
//   bytes 5..   payload (meaning depends on the type)
//
// Driver traffic (TEXT / BIN) is passed through byte for byte: the hub and bridge never parse the
// JSON the remote and the driver exchange, so the link adds no serialisation cost, only 5 bytes.
//
// Heartbeat: a PING is only sent when nothing else has been heard for a while (any frame proves the
// other side is alive). While the remote is in standby (STATUS { standby: true }) both sides check
// in only once a minute, so the remote's Wi-Fi radio can stay asleep; on wake the bridge checks the
// link at once and reconnects within about a second if it died during sleep.
//
// Session opening is pipelined: the bridge sends OPEN and immediately follows with TEXT frames;
// the hub queues them until its connection to the driver is up. No extra round trip.
//
// This file is shared: shared/linkproto.js is the source; bridge/src/bin and hub/src keep copies
// (test/proto-sync-test.js fails when they drift; run `node tools/sync-proto.js`).

export const PROTO_VERSION = 1;

export const T = Object.freeze({
  HELLO: 0x01, // bridge -> hub, ch 0, JSON { proto, token, bridge, remote }
  WELCOME: 0x02, // hub -> bridge, ch 0, JSON { proto, hub, version, drivers }
  DENIED: 0x03, // hub -> bridge, ch 0, UTF-8 reason; hub closes the link after it
  CATALOG: 0x04, // hub -> bridge, ch 0, JSON { drivers, removed }
  PING: 0x05, // either way, ch 0, 8 bytes opaque (sender's timestamp), answered with PONG
  PONG: 0x06, // echo of the PING payload
  STATUS: 0x07, // bridge -> hub, ch 0, JSON { standby: bool }: the remote is asleep / awake
  OPEN: 0x10, // bridge -> hub, ch n, UTF-8 hosted driver id
  OPEN_FAIL: 0x11, // hub -> bridge, ch n, UTF-8 reason (channel is dead after this)
  TEXT: 0x12, // either way, ch n, UTF-8 WebSocket text message (Integration API JSON)
  BIN: 0x13, // either way, ch n, binary WebSocket message (e.g. voice protobuf)
  CLOSE: 0x14, // either way, ch n, u16 close code + UTF-8 reason
  OPENED: 0x15 // hub -> bridge, ch n, empty: the driver connection is up (informational)
});

const NAMES = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));
export const typeName = (t) => NAMES[t] || `0x${t.toString(16)}`;

const HEADER = 5;

/** Encodes one frame. payload: Buffer | string | undefined */
export function encode(type, channel, payload) {
  const body = payload === undefined ? EMPTY : typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const buf = Buffer.allocUnsafe(HEADER + body.length);
  buf[0] = type;
  buf.writeUInt32BE(channel >>> 0, 1);
  body.copy(buf, HEADER);
  return buf;
}
const EMPTY = Buffer.alloc(0);

/** Decodes one frame. Returns { type, channel, payload } or null if malformed. */
export function decode(data) {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buf.length < HEADER) return null;
  return { type: buf[0], channel: buf.readUInt32BE(1), payload: buf.subarray(HEADER) };
}

export const json = (type, obj) => encode(type, 0, JSON.stringify(obj));
export const parseJson = (payload) => {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
};

export function encodeClose(channel, code = 1000, reason = "") {
  const r = Buffer.from(String(reason).slice(0, 120), "utf8");
  const p = Buffer.allocUnsafe(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return encode(T.CLOSE, channel, p);
}

export function decodeClose(payload) {
  if (payload.length < 2) return { code: 1000, reason: "" };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") };
}

/** WebSocket close codes that may be sent by an application (1000, 1001, 1003, 1007-1014, 3000-4999). */
export function safeCloseCode(code) {
  if (code === 1000 || code === 1001 || code === 1003) return code;
  if (code >= 1007 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

/** Time payload for PING: 8 bytes, milliseconds as float64 (performance.now based). */
export function pingPayload(now = performance.now()) {
  const b = Buffer.allocUnsafe(8);
  b.writeDoubleBE(now, 0);
  return b;
}
export const pingTime = (payload) => (payload.length >= 8 ? payload.readDoubleBE(0) : NaN);

/** Remote-side driver id for a hosted driver: pgs_<id>, only [A-Za-z0-9_-], max 36 chars. */
export function remoteDriverId(hostedId) {
  const clean = String(hostedId).replace(/[^A-Za-z0-9_-]/g, "_");
  return ("pgs_" + clean).slice(0, 36);
}
