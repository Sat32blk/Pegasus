// Pegasus link protocol: one persistent WebSocket between the Bridge (on the remote) and the Hub
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
// other side is alive): the Bridge after 15 s of quiet, telling its last round trip along with it,
// the hub only after 30 s. While the remote is in standby (STATUS { standby: true }) neither side
// checks in at all, so the remote's Wi-Fi radio can stay asleep; on wake the Bridge checks the link
// at once, and whenever it sends something after a quiet spell, and replaces a link that stays
// silent (see Resume). Bridges and hubs from before resume keep their own, faster check-ins.
//
// Session opening is pipelined: the bridge sends OPEN and immediately follows with TEXT frames;
// the hub queues them until its connection to the driver is up. No extra round trip.
//
// Resume (hub 0.12 / Bridge 0.5): a link that drops (the remote slept, Wi-Fi blinked) is replaced
// without ending the sessions on it. Both ends count the channel frames (types 0x10-0x1f) they
// sent and received on a link session and keep the last ones sent; the new connection's HELLO /
// WELCOME carry the session id and "rx" (how many were received), and each end sends again what
// the other missed. Frames "sent" while the link is away just wait in that window. The remote's
// core and the integrations notice nothing; a press made right after waking is not lost.
//
// This file is shared: shared/linkproto.js is the source; bridge/src/bin and hub/src keep copies
// (test/proto-sync-test.js fails when they drift; run `node tools/sync-proto.js`).

export const PROTO_VERSION = 1;

export const T = Object.freeze({
  HELLO: 0x01, // bridge -> hub, ch 0, JSON { proto, token, bridge, remote, standby, lan?, caps?, resume?: { id, rx } }
  WELCOME: 0x02, // hub -> bridge, ch 0, JSON { proto, hub, version, drivers, caps?, session?, resume?: { rx } }
  DENIED: 0x03, // hub -> bridge, ch 0, UTF-8 reason; hub closes the link after it
  CATALOG: 0x04, // hub -> bridge, ch 0, JSON { drivers, removed }
  PING: 0x05, // either way, ch 0, opaque (8 bytes: sender's timestamp; bridge: + 8 bytes, its last round trip in ms), answered with PONG
  PONG: 0x06, // echo of the PING payload
  STATUS: 0x07, // bridge -> hub, ch 0, JSON { standby: bool }: the remote is asleep / awake
  OPEN: 0x10, // bridge -> hub, ch n, UTF-8 hosted driver id
  OPEN_FAIL: 0x11, // hub -> bridge, ch n, UTF-8 reason (channel is dead after this)
  TEXT: 0x12, // either way, ch n, UTF-8 WebSocket text message (Integration API JSON)
  BIN: 0x13, // either way, ch n, binary WebSocket message (e.g. voice protobuf)
  CLOSE: 0x14, // either way, ch n, u16 close code + UTF-8 reason
  OPENED: 0x15, // hub -> bridge, ch n, empty: the driver connection is up (informational)
  RPC: 0x20, // either way, ch 0, JSON { id, method, params }: a request (moves, settings transfer)
  RPC_RESULT: 0x21 // either way, ch 0, JSON { id, result } or { id, error }
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

/**
 * Time payload for PING: 8 bytes, milliseconds as float64 (performance.now based). The Bridge adds
 * the round trip it last measured (8 more bytes), so the hub needn't ping the remote to know it.
 */
export function pingPayload(now = performance.now(), lastRttMs = null) {
  const withRtt = typeof lastRttMs === "number" && Number.isFinite(lastRttMs);
  const b = Buffer.allocUnsafe(withRtt ? 16 : 8);
  b.writeDoubleBE(now, 0);
  if (withRtt) b.writeDoubleBE(lastRttMs, 8);
  return b;
}
export const pingTime = (payload) => (payload.length >= 8 ? payload.readDoubleBE(0) : NaN);
export const pingRtt = (payload) => (payload.length >= 16 ? payload.readDoubleBE(8) : NaN);

/** Frames that belong to a session (counted and kept for resume); control frames are not. */
export const isChannelFrame = (type) => type >= 0x10 && type <= 0x1f;

/**
 * The channel frames one end sent on a link session: numbered from 1, the newest kept so they can
 * be sent again after a reconnect. Bounded by count and bytes; when the other end needs a frame
 * that's gone, the session can't be resumed.
 */
export class SendWindow {
  constructor({ maxFrames = 1024, maxBytes = 2 * 1024 * 1024 } = {}) {
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    this.frames = []; // frames [first .. seq]
    this.first = 1; // number of frames[0]
    this.seq = 0; // number of the newest frame
    this.bytes = 0;
  }
  /** Remembers a frame that is being (or will be) sent. */
  push(frame) {
    this.seq++;
    this.frames.push(frame);
    this.bytes += frame.length;
    while (this.frames.length > 1 && (this.frames.length > this.maxFrames || this.bytes > this.maxBytes)) {
      this.bytes -= this.frames.shift().length;
      this.first++;
    }
  }
  /** The other end has frames 1..n: can everything after it still be sent? */
  covers(n) {
    return Number.isInteger(n) && n >= this.first - 1 && n <= this.seq;
  }
  /** Frames n+1 .. seq. */
  after(n) {
    return this.frames.slice(Math.max(0, n + 1 - this.first));
  }
  /** Frames not yet known to have arrived (after n), in bytes. */
  bytesAfter(n) {
    let b = 0;
    for (const f of this.after(n)) b += f.length;
    return b;
  }
}

/** Remote-side driver id for a hosted driver: pgs_<id>, only [A-Za-z0-9_-], max 36 chars. */
export function remoteDriverId(hostedId) {
  const clean = String(hostedId).replace(/[^A-Za-z0-9_-]/g, "_");
  return ("pgs_" + clean).slice(0, 36);
}

/**
 * Request/response on top of the link, usable from both ends.
 *   const rpc = new Rpc((frame) => ws.send(frame));  rpc.handle("name", async (params, ctx) => result)
 *   await rpc.call("name", params, timeoutMs);        rpc.onFrame(type, payload, ctx) for incoming frames
 */
export class Rpc {
  constructor(send, handlers = new Map()) {
    this.send = send;
    this.handlers = handlers;
    this.pending = new Map();
    this.next = 1;
  }
  handle(method, fn) {
    this.handlers.set(method, fn);
  }
  call(method, params = {}, timeoutMs = 30000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      try {
        this.send(encode(T.RPC, 0, JSON.stringify({ id, method, params })));
      } catch (e) {
        clearTimeout(t);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  /** Returns true if the frame was an RPC frame. */
  onFrame(type, payload, ctx) {
    if (type === T.RPC_RESULT) {
      const m = parseJson(payload);
      const p = m && this.pending.get(m.id);
      if (!p) return true;
      this.pending.delete(m.id);
      clearTimeout(p.t);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
      return true;
    }
    if (type !== T.RPC) return false;
    const m = parseJson(payload);
    if (!m || typeof m.id !== "number") return true;
    const fn = this.handlers.get(m.method);
    const reply = (obj) => {
      try {
        this.send(encode(T.RPC_RESULT, 0, JSON.stringify({ id: m.id, ...obj })));
      } catch {
        /* link gone */
      }
    };
    if (!fn) {
      reply({ error: `unknown request ${m.method}` });
      return true;
    }
    Promise.resolve()
      .then(() => fn(m.params || {}, ctx))
      .then((result) => reply({ result: result === undefined ? null : result }))
      .catch((e) => reply({ error: e?.message || String(e) }));
    return true;
  }
  /** Fails every waiting call (link dropped). */
  failAll(reason = "link lost") {
    for (const [id, p] of this.pending) {
      clearTimeout(p.t);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
