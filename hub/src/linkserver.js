// Hub side of the Pegasus link. Each connected Bridge (one per remote) gets the catalog of hosted
// drivers and opens channels; every channel is spliced onto a WebSocket to that driver on
// 127.0.0.1:<port>. Frames are forwarded without parsing.

import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { redact } from "./redact.js";
import { NetStats } from "./netstats.js";
import { SessionShaper } from "./shaper.js";
import { Rpc } from "./linkproto.js";
import { T, PROTO_VERSION, pingPayload, pingTime, encode, decode, json, parseJson, encodeClose, decodeClose, safeCloseCode, remoteDriverId } from "./linkproto.js";

const HELLO_TIMEOUT_MS = 5000;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;

export class LinkServer {
  constructor({ store, supervisor, version, log, battery, net, artwork }) {
    this.artwork = artwork || null;
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
      .map((l) => ({ remote: l.remote, bridge: l.bridge, address: l.address, since: l.since, sessions: l.sessions.size, rttMs: l.rttMs, standby: !!l.standby, standbySince: l.standbySince || null, access: l.access ?? null, bridgeCpu: bridgeCpu(l), problems: l.problems || {}, notes: l.notes || {}, moves: l.moves || {} }));
  }

  #accept(ws, req) {
    const link = {
      ws,
      ready: false,
      address: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().replace(/^::ffff:/, ""),
      // the address the Bridge dialed (what the remote can reach the hub at, even when the hub runs
      // in a Docker bridge network with its port published under another number)
      host: String(req.headers.host || ""),
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
        // the remote's own address, as it reports it: behind Docker NAT the connection may come
        // from the gateway instead, which isn't where the remote's API is
        const lan = String(hello.lan || "");
        if (isRemoteAddress(lan) && lan !== link.address) {
          this.log(`link from ${link.address}: the remote reports its address as ${lan}`);
          link.address = lan;
        }
        link.standby = !!hello.standby;
        // the remote's host name is sometimes reported with ".local" (it changed after a restart
        // of the remote): one name, so its history and battery figures stay together
        link.remote = String(hello.remote || "remote").replace(/\.local\.?(?=$| \()/i, "").replace(/\.(?=$| \()/, "").slice(0, 80);
        link.bridge = String(hello.bridge || "?").slice(0, 20);
        this.log(`link up: ${link.remote} (bridge ${link.bridge}) from ${link.address}`);
        this.net.linkUp(link.remote);
        this.#tx(
          link,
          json(T.WELCOME, {
            proto: PROTO_VERSION,
            hub: process.env.PEGASUS_NAME || "Pegasus Hub",
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
        const before = JSON.stringify([link.registered, link.moves && Object.fromEntries(Object.entries(link.moves).map(([k, v]) => [k, v.status]))]);
        if (st.registered && typeof st.registered === "object") link.registered = st.registered;
        if (st.problems && typeof st.problems === "object") link.problems = st.problems;
        if (st.notes && typeof st.notes === "object") link.notes = st.notes;
        if (typeof st.access === "boolean") link.access = st.access;
        if (st.moves && typeof st.moves === "object") link.moves = st.moves;
        if (JSON.stringify([link.registered, link.moves && Object.fromEntries(Object.entries(link.moves).map(([k, v]) => [k, v.status]))]) !== before) this.onRemoteChange?.(link.remote);
        if (Array.isArray(st.battery) && st.battery.length && this.battery) this.battery.add(link.remote, st.battery.slice(-5000));
        if (st.cpu && Number.isFinite(st.cpu.us) && Number.isFinite(st.cpu.at)) {
          const c = { us: st.cpu.us, at: st.cpu.at };
          if (!link.cpuFirst || c.us < (link.cpuLast?.us ?? 0)) link.cpuFirst = c; // Bridge restarted
          link.cpuLast = c;
        }
        if (Array.isArray(st.log)) link.bridgeLog = st.log.slice(-200).map((l) => redact(String(l).slice(0, 500)));
        if (typeof st.standby === "boolean" && st.standby !== link.standby) {
          link.standby = st.standby;
          link.standbySince = Date.now();
          if (!st.standby) this.#deliverHeld(link);
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
        if (!isBin && s.shaper) {
          const p2 = s.shaper.fromRemote(payload);
          if (!p2) return; // e.g. standby kept from an integration set to stay connected
        }
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

  /** On wake: everything held for this remote while it slept, per session, in one go. */
  #deliverHeld(link) {
    let n = 0;
    for (const [ch, s] of link.sessions) {
      if (!s.shaper?.hasHeld()) continue;
      for (const out of s.shaper.flush()) {
        this.#tx(link, encode(T.TEXT, ch, out));
        n++;
      }
    }
    if (n) this.log(`${link.remote} woke up: delivered ${n} held update(s)`);
  }

  #open(link, channel, remoteId) {
    const meta = this.store.list().find((m) => remoteDriverId(m.id) === remoteId || m.id === remoteId);
    if (!meta) return this.#tx(link, encode(T.OPEN_FAIL, channel, `not installed: ${remoteId}`));
    const state = this.sup.info(meta.id).state;
    if (state !== "running" && state !== "starting") {
      return this.#tx(link, encode(T.OPEN_FAIL, channel, `${meta.name} is ${state}`));
    }
    const driverWs = new WebSocket(`ws://127.0.0.1:${meta.port}/`, { perMessageDeflate: false, handshakeTimeout: 10000 });
    const s = {
      driverWs,
      queue: [],
      queued: 0,
      id: meta.id,
      closed: false,
      chain: Promise.resolve(),
      shaper: process.env.PEGASUS_SHAPING === "0" ? null : new SessionShaper({ keepConnected: () => !!this.store.get(meta.id)?.keepConnected, count: (kind, n) => this.net.shaped(meta.id, kind, n) })
    };
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
      // in order, per session: artwork may need a moment (inline pictures are scaled down)
      s.chain = s.chain.then(async () => {
        let b = buf;
        if (!isBinary && this.artwork) b = await this.artwork.rewrite(buf, hubBase(link)).catch(() => buf);
        if (link.ws.readyState !== WebSocket.OPEN) return;
        if (isBinary || !s.shaper) return this.#tx(link, encode(isBinary ? T.BIN : T.TEXT, channel, b));
        for (const out of s.shaper.fromDriver(b, !!link.standby)) this.#tx(link, encode(T.TEXT, channel, out));
      }).catch(() => {});
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

/** How the remote reaches this hub: the address and port its link connected to. */
/** The Bridge's average processor use on the remote (% of one core) since it linked, or null. */
function bridgeCpu(l) {
  const a = l.cpuFirst, b = l.cpuLast;
  if (!a || !b || b.at - a.at < 60000) return null;
  return Math.round(((b.us - a.us) / 1000 / (b.at - a.at)) * 1000) / 10;
}

/** The hub as the remote reaches it ("http://host:port"), for links the remote fetches itself. */
export function hubBase(link) {
  const fixed = publicAddress();
  if (fixed) return `http://${fixed}`;
  if (link.host && !/^(127\.|localhost|\[::1\])/i.test(link.host)) return `http://${link.host}`;
  const sock = link.ws._socket;
  let a = String(sock?.localAddress || "").replace(/^::ffff:/, "");
  if (!a) return null;
  if (a.includes(":")) a = `[${a}]`;
  return `http://${a}:${sock.localPort}`;
}

/** PEGASUS_ADDRESS: "host" or "host:port" the remote reaches the hub at (set when it can't be found out). */
export function publicAddress() {
  const v = String(process.env.PEGASUS_ADDRESS || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!v) return null;
  const port = process.env.PEGASUS_PORT || 9600;
  return /:\d+$/.test(v) || /^\[.*\]:\d+$/.test(v) ? v : `${v.includes(":") ? `[${v}]` : v}:${port}`;
}

/** An address a remote can have on the LAN (not loopback, not unspecified). */
function isRemoteAddress(a) {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(a)) return !/^(127\.|0\.)/.test(a) && a.split(".").every((n) => Number(n) <= 255);
  return /^[0-9a-f:]+$/i.test(a) && a.includes(":") && a !== "::1" && a !== "::";
}

function tokenOk(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = crypto.createHash("sha256").update(norm(given)).digest();
  const b = crypto.createHash("sha256").update(norm(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
