// Hub side of the Pegasis link. Each connected Bridge (one per remote) gets the catalog of hosted
// drivers and opens channels; every channel is spliced onto a WebSocket to that driver on
// 127.0.0.1:<port>. Frames are forwarded without parsing.

import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { redact } from "./redact.js";
import { NetStats } from "./netstats.js";
import { Rpc } from "./linkproto.js";
import { T, PROTO_VERSION, pingPayload, pingTime, encode, decode, json, parseJson, encodeClose, decodeClose, safeCloseCode, remoteDriverId } from "./linkproto.js";

const HELLO_TIMEOUT_MS = 5000;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;

export class LinkServer {
  constructor({ store, supervisor, version, log, battery, net }) {
    this.battery = battery;
    this.net = net || new NetStats();
    this.store = store;
    this.sup = supervisor;
    this.version = version;
    this.log = log;
    this.links = new Set();
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.rpcHandlers = new Map(); // requests from bridges: handle(method, async (params, link) => result)
    this.wss.on("connection", (ws, req) => this.#accept(ws, req));
    this.catalogTimer = null;
    // Measure each link's round trip (shown on the page) and drop links that stopped answering.
    // Only quiet links are pinged; a remote in standby only once a minute so its radio can sleep.
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const l of this.links) {
        if (!l.ready) continue;
        const t = l.standby ? { ping: 60000, dead: 180000 } : { ping: 5000, dead: 20000 };
        const quiet = now - l.lastHeard;
        if (quiet > t.dead) {
          this.log(`link to ${l.remote} silent for ${Math.round(quiet / 1000)} s, dropping it`);
          l.ws.terminate();
          continue;
        }
        // quiet links are pinged to see they're alive; busy ones every 30 s too, for the round-trip figures
        // (the remote's radio is awake anyway while there's traffic)
        const due = quiet >= t.ping - 50 ? t.ping - 50 : l.standby ? Infinity : 30000;
        if (now - (l.lastPing || 0) >= due) {
          l.lastPing = now;
          this.#tx(l, encode(T.PING, 0, pingPayload()));
        }
      }
    }, 5000);
    this.pingTimer.unref?.();
  }

  /** Sends a frame to a bridge, counting it for the network statistics. */
  #tx(link, frame) {
    if (link.ws.readyState !== WebSocket.OPEN) return;
    link.ws.send(frame);
    if (link.remote) this.net.frame(link.remote, "out", frame.length);
  }

  handle(method, fn) {
    this.rpcHandlers.set(method, fn);
  }

  /** The ready link of a remote (by name), or null. */
  linkOf(remote) {
    for (const l of this.links) if (l.ready && l.remote === remote) return l;
    return null;
  }

  /** Asks a remote's Bridge something. */
  call(remote, method, params, timeoutMs) {
    const l = this.linkOf(remote);
    if (!l) return Promise.reject(new Error(`${remote} is not linked`));
    return l.rpc.call(method, params, timeoutMs);
  }

  handleUpgrade(req, socket, head) {
    socket.setNoDelay?.(true);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  catalog() {
    return this.store.list().map((m) => {
      const s = this.sup.info(m.id);
      return {
        id: m.id,
        remote_id: remoteDriverId(m.id), // bridge 0.1.x registers under this; newer bridges use driver_id
        driver_id: m.driverId,
        name: m.name,
        version: m.version,
        icon: m.icon,
        state: s.state,
        hold: !!m.hold
      };
    });
  }

  /** Tell every bridge about changes (debounced: installs and restarts come in bursts). */
  catalogChanged() {
    clearTimeout(this.catalogTimer);
    this.catalogTimer = setTimeout(() => {
      const frame = json(T.CATALOG, { drivers: this.catalog(), ...this.#removed() });
      for (const l of this.links) if (l.ready) this.#tx(l, frame);
    }, 150);
  }

  /** Uninstalled drivers: hub ids for new bridges, pgs_ ids for bridge 0.1.x. */
  #removed() {
    const ids = this.store.hub.removed.map((r) => r.id);
    return { removed_ids: ids, removed: ids.map(remoteDriverId) };
  }

  /** The Bridge's recent log for one remote (by name), or null. */
  bridgeLog(remote) {
    for (const l of this.links) if (l.ready && l.remote === remote) return l.bridgeLog || [];
    return null;
  }

  /** remote name -> the ID this integration has on that remote */
  shownAs(hubId) {
    const out = [];
    for (const l of this.links) {
      if (!l.ready) continue;
      if (l.registered?.[hubId]) out.push({ remote: l.remote, id: l.registered[hubId], note: l.notes?.[hubId] || null });
      else if (l.problems?.[hubId]) out.push({ remote: l.remote, id: null, problem: l.problems[hubId] });
      else out.push({ remote: l.remote, id: null, problem: l.registered ? "waiting for the remote" : "Bridge older than 0.2.0" });
    }
    return out;
  }

  status() {
    return [...this.links]
      .filter((l) => l.ready)
      .map((l) => ({ remote: l.remote, bridge: l.bridge, address: l.address, since: l.since, sessions: l.sessions.size, rttMs: l.rttMs, standby: !!l.standby, standbySince: l.standbySince || null, access: l.access ?? null, problems: l.problems || {}, notes: l.notes || {}, moves: l.moves || {} }));
  }

  #accept(ws, req) {
    const link = {
      ws,
      ready: false,
      address: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().replace(/^::ffff:/, ""),
      since: Date.now(),
      sessions: new Map(),
      remote: null,
      bridge: null,
      rttMs: null
    };
    link.rpc = new Rpc((frame) => this.#tx(link, frame), this.rpcHandlers);
    this.links.add(link);
    const helloTimer = setTimeout(() => ws.close(4001, "no hello"), HELLO_TIMEOUT_MS);

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      link.lastHeard = Date.now();
      const f = decode(data);
      if (!f) return;
      if (!link.ready) {
        if (f.type !== T.HELLO) return ws.close(4002, "hello expected");
        clearTimeout(helloTimer);
        const hello = parseJson(f.payload) || {};
        if (!tokenOk(hello.token, this.store.hub.token)) {
          this.log(`link from ${link.address} refused: wrong pairing code`);
          ws.send(encode(T.DENIED, 0, "wrong pairing code"));
          return ws.close(4003, "denied");
        }
        link.ready = true;
        link.standby = !!hello.standby;
        link.remote = String(hello.remote || "remote").slice(0, 80);
        link.bridge = String(hello.bridge || "?").slice(0, 20);
        this.log(`link up: ${link.remote} (bridge ${link.bridge}) from ${link.address}`);
        this.net.linkUp(link.remote);
        this.#tx(
          link,
          json(T.WELCOME, {
            proto: PROTO_VERSION,
            hub: process.env.PEGASIS_NAME || "Pegasis Hub",
            version: this.version,
            drivers: this.catalog(),
            ...this.#removed()
          })
        );
        return;
      }
      this.net.frame(link.remote, "in", data.length ?? f.payload.length + 5);
      this.#frame(link, f);
    });

    ws.on("close", () => {
      link.rpc.failAll("remote link lost");
      clearTimeout(helloTimer);
      this.links.delete(link);
      for (const [ch, s] of link.sessions) this.#endSession(link, ch, s, 1001, "link closed", false);
      if (link.ready) {
        this.log(`link down: ${link.remote}`);
        this.net.linkDown(link.remote);
      }
    });
    ws.on("error", () => {});
  }

  #frame(link, f) {
    const { type, channel, payload } = f;
    if (link.rpc.onFrame(type, payload, link)) return;
    switch (type) {
      case T.PING:
        this.#tx(link, encode(T.PONG, 0, payload));
        return;
      case T.PONG: {
        const rtt = performance.now() - pingTime(payload);
        if (rtt >= 0 && rtt < 60000) {
          link.rttMs = rtt;
          this.net.rtt(link.remote, rtt);
        }
        return;
      }
      case T.STATUS: {
        const st = parseJson(payload) || {};
        if (st.registered && typeof st.registered === "object") link.registered = st.registered;
        if (st.problems && typeof st.problems === "object") link.problems = st.problems;
        if (st.notes && typeof st.notes === "object") link.notes = st.notes;
        if (typeof st.access === "boolean") link.access = st.access;
        if (st.moves && typeof st.moves === "object") link.moves = st.moves;
        if (Array.isArray(st.battery) && st.battery.length && this.battery) this.battery.add(link.remote, st.battery.slice(-5000));
        if (Array.isArray(st.log)) link.bridgeLog = st.log.slice(-200).map((l) => redact(String(l).slice(0, 500)));
        if (typeof st.standby === "boolean" && st.standby !== link.standby) {
          link.standby = st.standby;
          link.standbySince = Date.now();
        }
        return;
      }
      case T.OPEN:
        return this.#open(link, channel, payload.toString("utf8"));
      case T.TEXT:
      case T.BIN: {
        const s = link.sessions.get(channel);
        if (!s) return;
        const isBin = type === T.BIN;
        this.net.message(s.id, channel, "in", payload, !isBin);
        if (s.driverWs.readyState === WebSocket.OPEN) s.driverWs.send(payload, { binary: isBin });
        else if (s.driverWs.readyState === WebSocket.CONNECTING) {
          s.queued += payload.length;
          if (s.queued > MAX_QUEUE_BYTES) return this.#endSession(link, channel, s, 1009, "queue overflow", true);
          s.queue.push([Buffer.from(payload), isBin]);
        }
        return;
      }
      case T.CLOSE: {
        const s = link.sessions.get(channel);
        if (s) {
          const { code, reason } = decodeClose(payload);
          this.#endSession(link, channel, s, code, reason, false);
        }
        return;
      }
    }
  }

  #open(link, channel, remoteId) {
    const meta = this.store.list().find((m) => remoteDriverId(m.id) === remoteId || m.id === remoteId);
    if (!meta) return this.#tx(link, encode(T.OPEN_FAIL, channel, `not installed: ${remoteId}`));
    const state = this.sup.info(meta.id).state;
    if (state !== "running" && state !== "starting") {
      return this.#tx(link, encode(T.OPEN_FAIL, channel, `${meta.name} is ${state}`));
    }
    const driverWs = new WebSocket(`ws://127.0.0.1:${meta.port}/`, { perMessageDeflate: false, handshakeTimeout: 10000 });
    const s = { driverWs, queue: [], queued: 0, id: meta.id, closed: false };
    link.sessions.set(channel, s);
    this.net.sessionOpened(meta.id);

    driverWs.on("open", () => {
      driverWs._socket?.setNoDelay?.(true);
      for (const [buf, isBin] of s.queue) driverWs.send(buf, { binary: isBin });
      s.queue = [];
      s.queued = 0;
      if (link.ws.readyState === WebSocket.OPEN) this.#tx(link, encode(T.OPENED, channel));
    });
    driverWs.on("message", (data, isBinary) => {
      if (link.ws.readyState !== WebSocket.OPEN) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      this.net.message(s.id, channel, "out", buf, !isBinary);
      this.#tx(link, encode(isBinary ? T.BIN : T.TEXT, channel, buf));
    });
    driverWs.on("close", (code, reason) => {
      if (s.closed) return;
      s.closed = true;
      link.sessions.delete(channel);
      if (link.ws.readyState === WebSocket.OPEN) this.#tx(link, encodeClose(channel, safeCloseCode(code), reason.toString()));
    });
    driverWs.on("error", (e) => {
      if (s.closed) return;
      s.closed = true;
      link.sessions.delete(channel);
      this.sup.note(meta.id, `link session failed: ${e.message}`);
      this.net.sessionFailed(meta.id);
      if (link.ws.readyState === WebSocket.OPEN) this.#tx(link, encode(T.OPEN_FAIL, channel, e.message));
    });
  }

  #endSession(link, channel, s, code, reason, tellBridge) {
    if (s.closed) return;
    s.closed = true;
    link.sessions.delete(channel);
    try {
      if (s.driverWs.readyState === WebSocket.OPEN) s.driverWs.close(safeCloseCode(code), reason);
      else s.driverWs.terminate();
    } catch {
      /* ignore */
    }
    if (tellBridge) this.#tx(link, encodeClose(channel, code, reason));
  }

  /** Drops all sessions of one hosted driver (e.g. it is being restarted or updated). */
  dropDriver(id) {
    for (const link of this.links) for (const [ch, s] of link.sessions) if (s.id === id) this.#endSession(link, ch, s, 1012, "driver restarting", true);
  }

  /** Disconnects every bridge (e.g. new pairing code); they reconnect and must pass the new code. */
  disconnectAll(code = 1001, reason = "hub stopping") {
    for (const l of this.links) l.ws.close(code, reason);
  }

  close() {
    clearInterval(this.pingTimer);
    this.disconnectAll();
  }
}

function tokenOk(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = crypto.createHash("sha256").update(norm(given)).digest();
  const b = crypto.createHash("sha256").update(norm(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
