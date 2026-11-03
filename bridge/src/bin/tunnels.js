// Loopback endpoints on the remote, one per hosted driver. The remote's core connects to
// ws://127.0.0.1:<port> exactly as it would to any external integration driver; each connection
// becomes a channel on the hub link. Messages are forwarded as raw bytes, never parsed.

import net from "node:net";
import { WebSocketServer } from "ws";
import { safeCloseCode } from "./linkproto.js";

export class Tunnels {
  constructor({ link, log = () => {}, host = "127.0.0.1" }) {
    this.link = link;
    this.log = log;
    this.host = host;
    this.servers = new Map(); // remoteId -> { wss, port, conns:Set }
  }

  has(remoteId) {
    return this.servers.has(remoteId);
  }

  portOf(remoteId) {
    return this.servers.get(remoteId)?.port ?? null;
  }

  /** Starts (or keeps) the loopback endpoint for a driver. Resolves with the port in use. */
  async ensure(remoteId, preferredPort) {
    const have = this.servers.get(remoteId);
    if (have) return have.port;
    const port = await this.#listen(remoteId, preferredPort);
    return port;
  }

  async #listen(remoteId, preferredPort) {
    for (const port of [preferredPort, 0].filter((p) => p !== undefined && p !== null)) {
      try {
        const wss = await new Promise((resolve, reject) => {
          const s = new WebSocketServer({ host: this.host, port, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
          s.once("listening", () => resolve(s));
          s.once("error", reject);
        });
        const entry = { wss, port: wss.address().port, conns: new Set() };
        wss.on("connection", (ws, req) => this.#connection(remoteId, entry, ws, req));
        wss.on("error", (e) => this.log(`${remoteId} endpoint: ${e.message}`));
        this.servers.set(remoteId, entry);
        return entry.port;
      } catch (e) {
        if (port === 0) throw e;
        this.log(`${remoteId}: port ${port} busy (${e.code || e.message}), picking another`);
      }
    }
    throw new Error("no port");
  }

  #connection(remoteId, entry, ws) {
    ws._socket?.setNoDelay?.(true);
    entry.conns.add(ws);
    ws.on("close", () => entry.conns.delete(ws));
    const ch = this.link.open(remoteId, {
      onText: (buf) => ws.send(buf, { binary: false }),
      onBin: (buf) => ws.send(buf, { binary: true }),
      onClose: (code, reason) => {
        if (ws.readyState <= 1) ws.close(safeCloseCode(code), String(reason || "").slice(0, 120));
      }
    });
    if (!ch) {
      // hub offline: the core retries on its own, and the link reconnects meanwhile
      ws.close(1013, "Pegasis hub offline");
      return;
    }
    ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      if (isBinary) ch.sendBin(buf);
      else ch.sendText(buf);
    });
    ws.on("close", (code, reason) => ch.close(safeCloseCode(code), reason?.toString() || ""));
    ws.on("error", () => {});
  }

  /** Closes every connection (e.g. the link dropped): the core reconnects when it is back. */
  dropAll(code = 1012, reason = "hub link lost") {
    for (const e of this.servers.values()) for (const ws of e.conns) ws.close(code, reason);
  }

  async remove(remoteId) {
    const e = this.servers.get(remoteId);
    if (!e) return;
    this.servers.delete(remoteId);
    for (const ws of e.conns) ws.terminate();
    await new Promise((r) => e.wss.close(() => r()));
  }

  async closeAll() {
    await Promise.all([...this.servers.keys()].map((id) => this.remove(id)));
  }
}

/** True if the TCP port is free on host. */
export function portFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}
