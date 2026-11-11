// Bridge side of the Pegasus link: one persistent WebSocket to the hub carrying every driver
// session as a numbered channel. Reconnects by itself, measures round-trip time.
//
// Easy on the remote's battery and quick after waking:
//  - awake and quiet, it checks in every 15 s (each check-in wakes the Wi-Fi radio); asleep, never
//  - a dead link is found when it matters: when the remote wakes, and when something is sent after
//    a quiet spell (a check-in goes with it; no answer within a moment and the link is replaced)
//  - a replaced link resumes the sessions that were on it (hub 0.12+): nothing is lost, the
//    remote's core doesn't have to reconnect and ask every integration for everything again

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { T, PROTO_VERSION, encode, decode, json, parseJson, encodeClose, decodeClose, pingPayload, pingTime, isChannelFrame, SendWindow, Rpc } from "./linkproto.js";

// awake: check in after 15 s of silence, give up after 35 s. A hub before 0.12 expects to hear
// something every 20 s and checks in itself every 5 s, which keeps the link alive there.
const AWAKE = { tick: 5000, ping: 15000, dead: 35000 };
// On wake, a link that does not answer within this is replaced. With a hub that resumes sessions
// a needless replacement costs one handshake and loses nothing, so it can be quick; without, it
// would make the core reconnect every integration.
const WAKE_CHECK_MS = { resume: 400, plain: 1500 };
const PROBE_AFTER_MS = 3000; // sending after this much silence: check the link along with it
const PROBE_MS = 1000; // ...and replace it if nothing at all comes back within this (hubs that resume)
const FAST_RETRIES = 12; // reconnect attempts every 250 ms (about 3 s) before backing off
const RESUME_GRACE_MS = 8000; // awake without the hub for this long: sessions are given up
const WINDOW = { maxFrames: 512, maxBytes: 1024 * 1024 }; // frames kept for resume (on the remote)

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
    // resume (hub 0.12+): the link session's id, the frames sent on it, how many were received
    this.session = null;
    this.win = new SendWindow(WINDOW);
    this.rx = 0;
    this.suspended = false; // the link is away but its sessions are kept
    this.resumed = false; // the current link took over the sessions of the one before
    this.hubCaps = [];
    this.stats = { resumes: 0, replayed: 0, pings: 0 };
  }

  /** The hub supports this (e.g. "resume", "delta"). */
  hubCan(cap) {
    return this.hubCaps.includes(cap);
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
    if (on) {
      clearTimeout(this.graceTimer); // asleep, the sessions wait for as long as the hub keeps them
      return;
    }
    // Woke up. The link may have died while the radio slept, and a dead TCP connection can take
    // many seconds to notice: probe it now and replace it quickly if it stays silent.
    if (this.suspended) this.#armGrace();
    if (!this.up) {
      clearTimeout(this.retryTimer);
      this.retry = 0;
      if (!this.stopped && (!this.ws || this.ws.readyState > WebSocket.OPEN)) this.#connect();
      return;
    }
    this.#probe(this.hubCan("resume") ? WAKE_CHECK_MS.resume : WAKE_CHECK_MS.plain, "link did not answer after wake, reconnecting", true);
  }

  /** Checks the link now; if nothing at all is heard within ms, it is replaced. */
  #probe(ms, why, restart = false) {
    const ws = this.ws;
    if (!this.up || ws?.readyState !== WebSocket.OPEN || (this.probing && !restart)) return;
    const sentAt = Date.now();
    this.probing = true;
    this.#ping();
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.probing = false;
      if (this.ws === ws && this.lastHeard < sentAt) {
        this.log(why);
        this.retry = 0;
        ws.terminate();
      }
    }, ms);
  }

  /** The sessions of a lost link are kept this long (while awake) for the next link to take over. */
  #armGrace() {
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      if (!this.suspended) return;
      this.log("hub still away: closing the sessions that were waiting for it");
      this.#giveUp();
    }, RESUME_GRACE_MS);
  }

  /** Ends the sessions of a link that can't be resumed. */
  #giveUp() {
    clearTimeout(this.graceTimer);
    this.suspended = false;
    this.session = null;
    this.win = new SendWindow(WINDOW);
    this.rx = 0;
    for (const ch of this.channels.values()) ch._ended(1012, "hub link lost");
    this.channels.clear();
  }

  /**
   * Sends a session frame: remembered for resume, sent now if the link is up (else when the next
   * link takes the session over). False if there is no link and no session to wait for.
   */
  #sendCh(frame) {
    const live = this.up && this.ws?.readyState === WebSocket.OPEN;
    // (a connection that is closing but hasn't said so yet counts as away: the frame waits)
    if (this.session) this.win.push(frame);
    else if (!live) return false;
    if (live) {
      this.#write(frame);
      // something is being asked of the hub after a quiet spell: make sure it is still there
      if (this.session && Date.now() - this.lastHeard > PROBE_AFTER_MS) this.#probe(PROBE_MS, "hub did not answer, reconnecting");
    }
    return true;
  }

  /** Writes to the socket; frames written in the same turn leave in one packet. */
  #write(frame) {
    const ws = this.ws;
    const sock = ws._socket;
    if (sock && !this.corked) {
      this.corked = true;
      sock.cork();
      process.nextTick(() => {
        this.corked = false;
        sock.uncork();
      });
    }
    ws.send(frame);
  }

  /** Tells the hub about this remote (e.g. which ID each integration got here). */
  report(obj) {
    if (this.up && this.ws?.readyState === WebSocket.OPEN) this.ws.send(json(T.STATUS, obj));
  }

  #ping() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.lastPing = Date.now();
    this.stats.pings++;
    this.ws.send(encode(T.PING, 0, pingPayload(performance.now(), this.rttMs)));
  }

  /**
   * Awake: pings when the link has been quiet for a while. Asleep: nothing at all (the radio can
   * stay off; the link is checked the moment the remote wakes). A hub before 0.12 drops a link
   * it hasn't heard from in 3 minutes of standby, so there the once-a-minute check-in stays.
   */
  #armHeartbeat() {
    clearInterval(this.pingTimer);
    if (!this.up) return;
    if (this.standby) {
      if (this.hubCan("resume")) return;
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastHeard > 180000) return this.ws?.terminate();
        if (Date.now() - this.lastHeard >= 59000) this.#ping();
      }, 60000);
      return;
    }
    const t = AWAKE;
    this.pingTimer = setInterval(() => {
      const quiet = Date.now() - this.lastHeard;
      if (quiet > t.dead) {
        this.log("hub stopped answering, reconnecting");
        return this.ws?.terminate();
      }
      if (quiet >= t.ping - 50 && Date.now() - this.lastPing >= t.ping - 50) this.#ping();
    }, t.tick);
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
    clearTimeout(this.graceTimer);
    clearInterval(this.pingTimer);
    this.ws?.terminate();
    this.ws = null;
    this.#giveUp();
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
      const resume = this.suspended && this.session ? { resume: { id: this.session, rx: this.rx } } : {};
      ws.send(json(T.HELLO, { proto: PROTO_VERSION, token: this.token, bridge: this.version, remote: this.remote, standby: this.standby, caps: ["resume", "delta"], ...resume, ...(lan ? { lan } : {}) }));
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      this.lastHeard = Date.now(); // any frame proves the hub is alive
      const f = decode(data);
      if (!f) return;
      if (isChannelFrame(f.type)) this.rx++;
      switch (f.type) {
        case T.WELCOME: {
          const w = parseJson(f.payload) || {};
          this.hubCaps = Array.isArray(w.caps) ? w.caps.map(String) : [];
          this.hubInfo = { name: w.hub, version: w.version, batteryUpTo: Number(w.batteryUpTo) || 0 };
          // take over the sessions of the link before, if the hub kept them and nothing is missing
          const r = w.resume;
          const takeOver = this.suspended && this.session && w.session === this.session && r && this.win.covers(r.rx);
          if (takeOver) {
            const again = this.win.after(r.rx);
            ws._socket?.cork();
            for (const frame of again) ws.send(frame);
            ws._socket?.uncork();
            this.stats.resumes++;
            this.stats.replayed += again.length;
            clearTimeout(this.graceTimer);
            this.suspended = false;
            this.log(`link back at ${this.url()}: ${this.channels.size} session(s) carried on${again.length ? `, ${again.length} message(s) sent again` : ""}`);
          } else {
            if (this.suspended) this.log("the hub no longer has the sessions of the link before: starting them again");
            this.#giveUp();
            if (r) {
              // the hub resumed but this end can't (too much was sent meanwhile): start clean
              this.retry = 0;
              return ws.terminate();
            }
            this.session = this.hubCaps.includes("resume") && typeof w.session === "string" ? w.session : null;
            this.log(`linked to ${w.hub} ${w.version} at ${this.url()}`);
          }
          this.resumed = !!takeOver;
          this.up = true;
          this.rpc = rpc;
          this.retry = 0;
          this.probing = false;
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

    ws.on("close", (code) => {
      rpc.failAll("hub link lost");
      if (this.rpc === rpc) this.rpc = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.wakeTimer);
      const wasUp = this.up;
      this.up = false;
      this.probing = false;
      if (this.ws === ws) this.ws = null;
      // keep the sessions for the next link to take over (hub 0.12+); else they end here
      // (1001: the hub is stopping or wants every Bridge to start over; it kept nothing)
      if (wasUp && this.session && !this.stopped && this.state !== "denied" && code !== 1001) {
        if (!this.suspended) {
          this.suspended = true;
          if (!this.standby) this.#armGrace();
        }
      } else if (!this.suspended || this.state === "denied") this.#giveUp();
      if (this.state !== "denied") this.#setState("down", wasUp ? "link lost" : "hub not reachable");
      if (this.stopped) return;
      // denied: the pairing code is wrong; try again slowly (the hub may have been reset).
      // Otherwise at once when a working link broke (not when the hub said goodbye), then every
      // 250 ms for a few seconds (after waking, Wi-Fi needs a moment), then backing off.
      const n = this.retry++;
      const delay = this.state === "denied" ? 60000 : n < FAST_RETRIES && !this.standby ? (wasUp && n === 0 && code !== 1001 ? 10 : n === 0 ? 300 : 250) : Math.min(this.standby ? 60000 : 10000, 300 * 2 ** (n - (this.standby ? 0 : FAST_RETRIES)));
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
    if (!(this.up && this.ws) && !this.suspended) return null;
    const id = this.nextChannel++;
    if (this.nextChannel > 0xfffffff0) this.nextChannel = 1;
    let ended = false;
    const ch = {
      id,
      ...handlers,
      sendText: (buf) => !ended && this.#sendCh(encode(T.TEXT, id, buf)),
      sendBin: (buf) => !ended && this.#sendCh(encode(T.BIN, id, buf)),
      close: (code = 1000, reason = "") => {
        if (ended) return;
        ended = true;
        this.channels.delete(id);
        this.#sendCh(encodeClose(id, code, reason));
      },
      _ended: (code, reason) => {
        if (ended) return;
        ended = true;
        ch.onClose?.(code, reason);
      }
    };
    this.channels.set(id, ch);
    this.#sendCh(encode(T.OPEN, id, remoteId));
    return ch;
  }
}

/** Hub ids of uninstalled drivers (hub 0.1.x only sent them as "pgs_<id>"). */
function removedIds(msg) {
  if (Array.isArray(msg.removed_ids)) return msg.removed_ids;
  return (msg.removed || []).map((r) => (String(r).startsWith("pgs_") ? String(r).slice(4) : String(r)));
}
