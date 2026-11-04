// Bridge side of the Pegasus link: one persistent WebSocket to the hub carrying every driver
// session as a numbered channel. Reconnects by itself, measures round-trip time.

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { T, PROTO_VERSION, encode, decode, json, parseJson, encodeClose, decodeClose, pingPayload, pingTime, Rpc } from "./linkproto.js";

// awake: check in after 5 s of silence, give up after 15 s; standby: once a minute, give up after 3 min
const AWAKE = { ping: 5000, dead: 15000 };
const ASLEEP = { ping: 60000, dead: 180000 };
const WAKE_CHECK_MS = 1500; // on wake, a link that does not answer within this is replaced

export class LinkClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.hub      host:port of the hub
   * @param {string} o.token    pairing code
   * @param {string} o.remote   name of this remote (shown on the hub page)
   * @param {string} o.version  bridge version
   */
  constructor({ hub, token, remote, version, log = () => {} }) {
    super();
    this.hub = hub;
    this.token = token;
    this.remote = remote;
    this.version = version;
    this.log = log;
    this.ws = null;
    this.up = false;
    this.state = "idle"; // idle | connecting | up | down | denied
    this.reason = "";
    this.rttMs = null;
    this.channels = new Map();
    this.nextChannel = 1;
    this.retry = 0;
    this.stopped = true;
    this.hubInfo = null;
    this.standby = false;
    this.lastHeard = 0;
    this.lastPing = 0;
    this.rpcHandlers = new Map();
    this.rpc = null;
  }

  /** Answers requests from the hub: handle("move.toHub", async (params) => result). */
  handle(method, fn) {
    this.rpcHandlers.set(method, fn);
  }

  /** Asks the hub something. Rejects if the link is down or drops. */
  call(method, params, timeoutMs) {
    if (!this.up || !this.rpc) return Promise.reject(new Error("hub not connected"));
    return this.rpc.call(method, params, timeoutMs);
  }

  /** The remote went to sleep / woke up. */
  setStandby(on) {
    on = !!on;
    if (on === this.standby) return;
    this.standby = on;
    const ws = this.ws;
    if (this.up && ws?.readyState === WebSocket.OPEN) ws.send(json(T.STATUS, { standby: on }));
    this.#armHeartbeat();
    if (on) return;
    // Woke up. The link may have died while the radio slept, and a dead TCP connection can take
    // many seconds to notice: probe it now and replace it quickly if it stays silent.
    if (!this.up) {
      clearTimeout(this.retryTimer);
      this.retry = 0;
      if (!this.stopped && (!this.ws || this.ws.readyState > WebSocket.OPEN)) this.#connect();
      return;
    }
    const sentAt = Date.now();
    this.#ping();
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      if (this.ws === ws && this.lastHeard < sentAt) {
        this.log("link did not answer after wake, reconnecting");
        this.retry = 0;
        ws.terminate();
      }
    }, WAKE_CHECK_MS);
  }

  /** Tells the hub about this remote (e.g. which ID each integration got here). */
  report(obj) {
    if (this.up && this.ws?.readyState === WebSocket.OPEN) this.ws.send(json(T.STATUS, obj));
  }

  #ping() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.lastPing = Date.now();
    this.ws.send(encode(T.PING, 0, pingPayload()));
  }

  /** One timer at the current check-in interval; pings only when the link has been quiet. */
  #armHeartbeat() {
    clearInterval(this.pingTimer);
    if (!this.up) return;
    const t = this.standby ? ASLEEP : AWAKE;
    this.pingTimer = setInterval(() => {
      const quiet = Date.now() - this.lastHeard;
      if (quiet > t.dead) {
        this.log("hub stopped answering, reconnecting");
        return this.ws?.terminate();
      }
      if (quiet >= t.ping - 50 && Date.now() - this.lastPing >= t.ping - 50) this.#ping();
    }, t.ping);
  }

  url() {
    const h = String(this.hub).trim().replace(/^wss?:\/\//, "").replace(/\/.*$/, "");
    return `ws://${h.includes(":") ? h : `${h}:9600`}/link`;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.wakeTimer);
    clearInterval(this.pingTimer);
    this.ws?.terminate();
    this.ws = null;
  }

  #setState(state, reason = "") {
    this.state = state;
    this.reason = reason;
    this.emit("state", state, reason);
  }

  #connect() {
    if (this.stopped) return;
    this.#setState("connecting");
    const ws = new WebSocket(this.url(), { perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    const rpc = new Rpc((frame) => ws.readyState === WebSocket.OPEN && ws.send(frame), this.rpcHandlers);

    ws.on("open", () => {
      ws._socket?.setNoDelay?.(true);
      // lan: the remote's own address on the way to the hub (a hub in a Docker bridge network may
      // only see the gateway's address)
      const lan = String(ws._socket?.localAddress || "").replace(/^::ffff:/, "");
      ws.send(json(T.HELLO, { proto: PROTO_VERSION, token: this.token, bridge: this.version, remote: this.remote, standby: this.standby, ...(lan ? { lan } : {}) }));
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      this.lastHeard = Date.now(); // any frame proves the hub is alive
      const f = decode(data);
      if (!f) return;
      switch (f.type) {
        case T.WELCOME: {
          const w = parseJson(f.payload) || {};
          this.up = true;
          this.rpc = rpc;
          this.retry = 0;
          this.hubInfo = { name: w.hub, version: w.version };
          this.log(`linked to ${w.hub} ${w.version} at ${this.url()}`);
          this.#setState("up");
          this.emit("catalog", w.drivers || [], removedIds(w));
          this.#armHeartbeat();
          this.#ping();
          return;
        }
        case T.DENIED:
          this.#setState("denied", f.payload.toString("utf8"));
          this.log(`hub refused the link: ${this.reason}`);
          return;
        case T.CATALOG: {
          const c = parseJson(f.payload) || {};
          this.emit("catalog", c.drivers || [], removedIds(c));
          return;
        }
        case T.PING:
          ws.send(encode(T.PONG, 0, f.payload));
          return;
        case T.PONG: {
          const rtt = performance.now() - pingTime(f.payload);
          if (rtt >= 0 && rtt < 60000) {
            this.rttMs = rtt;
            this.emit("rtt", rtt);
          }
          return;
        }
        default:
          if (rpc.onFrame(f.type, f.payload, this)) return;
          return this.#channelFrame(f);
      }
    });

    ws.on("close", () => {
      rpc.failAll("hub link lost");
      if (this.rpc === rpc) this.rpc = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.wakeTimer);
      const wasUp = this.up;
      this.up = false;
      if (this.ws === ws) this.ws = null;
      for (const ch of this.channels.values()) ch._ended(1012, "hub link lost");
      this.channels.clear();
      if (this.state !== "denied") this.#setState("down", wasUp ? "link lost" : "hub not reachable");
      if (this.stopped) return;
      // denied: the pairing code is wrong; try again slowly (the hub may have been reset)
      const delay = this.state === "denied" ? 60000 : Math.min(this.standby ? 60000 : 10000, 300 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.#connect(), delay);
    });
    ws.on("error", (e) => {
      if (!this.up && this.retry < 2) this.log(`hub ${this.url()}: ${e.message}`);
    });
  }

  #channelFrame({ type, channel, payload }) {
    const ch = this.channels.get(channel);
    if (!ch) return;
    switch (type) {
      case T.TEXT:
        return ch.onText?.(payload);
      case T.BIN:
        return ch.onBin?.(payload);
      case T.OPENED:
        return ch.onOpened?.();
      case T.OPEN_FAIL:
        this.channels.delete(channel);
        return ch._ended(1013, payload.toString("utf8") || "driver unavailable");
      case T.CLOSE: {
        this.channels.delete(channel);
        const { code, reason } = decodeClose(payload);
        return ch._ended(code, reason);
      }
    }
  }

  /**
   * Opens a session to a hosted driver. Data may be sent right away (it is queued at the hub until
   * the driver connection is up). Handlers: onText(buf), onBin(buf), onClose(code, reason), onOpened().
   */
  open(remoteId, handlers) {
    if (!this.up || !this.ws) return null;
    const id = this.nextChannel++;
    if (this.nextChannel > 0xfffffff0) this.nextChannel = 1;
    const ws = this.ws;
    let ended = false;
    const ch = {
      id,
      ...handlers,
      sendText: (buf) => ws.readyState === WebSocket.OPEN && ws.send(encode(T.TEXT, id, buf)),
      sendBin: (buf) => ws.readyState === WebSocket.OPEN && ws.send(encode(T.BIN, id, buf)),
      close: (code = 1000, reason = "") => {
        if (ended) return;
        ended = true;
        this.channels.delete(id);
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeClose(id, code, reason));
      },
      _ended: (code, reason) => {
        if (ended) return;
        ended = true;
        ch.onClose?.(code, reason);
      }
    };
    this.channels.set(id, ch);
    ws.send(encode(T.OPEN, id, remoteId));
    return ch;
  }
}

/** Hub ids of uninstalled drivers (hub 0.1.x only sent them as "pgs_<id>"). */
function removedIds(msg) {
  if (Array.isArray(msg.removed_ids)) return msg.removed_ids;
  return (msg.removed || []).map((r) => (String(r).startsWith("pgs_") ? String(r).slice(4) : String(r)));
}
