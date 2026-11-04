// Persistent state under /data:
//   hub.json                         pairing token, removed-driver tombstones, settings
//   integrations/<id>/meta.json      what is installed and how to run it
//   integrations/<id>/app/           the driver's code (+ .venv or node_modules)
//   integrations/<id>/config/        the driver's own config (UC_CONFIG_HOME): survives updates
//   integrations/<id>/driver.log     its output

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, writeJson } from "./util.js";

const PORT_BASE = Number(process.env.PEGASUS_DRIVER_PORT_BASE || 10100);

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.intgDir = path.join(dataDir, "integrations");
    fs.mkdirSync(this.intgDir, { recursive: true });
    this.hubFile = path.join(dataDir, "hub.json");
    this.hub = readJson(this.hubFile, {});
    if (!this.hub.token) this.hub.token = newToken();
    if (!Array.isArray(this.hub.removed)) this.hub.removed = [];
    this.saveHub();
    this.items = new Map();
    for (const id of fs.readdirSync(this.intgDir)) {
      const m = readJson(path.join(this.intgDir, id, "meta.json"));
      if (m?.id === id) this.items.set(id, m);
    }
  }

  saveHub() {
    writeJson(this.hubFile, this.hub);
  }

  regenerateToken() {
    this.hub.token = newToken();
    this.saveHub();
    return this.hub.token;
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.items.get(id) || null;
  }

  put(meta) {
    this.items.set(meta.id, meta);
    writeJson(path.join(this.intgDir, meta.id, "meta.json"), meta);
    // installing again what was removed: no longer a tombstone
    const before = this.hub.removed.length;
    this.hub.removed = this.hub.removed.filter((r) => r.id !== meta.id);
    if (this.hub.removed.length !== before) this.saveHub();
  }

  remove(id) {
    this.items.delete(id);
    fs.rmSync(path.join(this.intgDir, id), { recursive: true, force: true });
    this.hub.removed = [...this.hub.removed.filter((r) => r.id !== id), { id, at: Date.now() }].slice(-200);
    this.saveHub();
  }

  freePort() {
    const used = new Set([...this.items.values()].map((m) => m.port));
    let p = PORT_BASE;
    while (used.has(p)) p++;
    return p;
  }

  dir(id) {
    return path.join(this.intgDir, id);
  }
  appDir(id) {
    return path.join(this.intgDir, id, "app");
  }
  configDir(id) {
    return path.join(this.intgDir, id, "config");
  }
  dataDirOf(id) {
    return path.join(this.intgDir, id, "data");
  }
  logFile(id) {
    return path.join(this.intgDir, id, "driver.log");
  }
}

function newToken() {
  // 20 chars, easy to type on the remote's keyboard: no 0/O/1/l/I
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(20);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}
