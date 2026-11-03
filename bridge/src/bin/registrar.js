// Keeps the remote's integration list in step with the hub's catalog: every hosted driver gets a
// loopback endpoint and is registered with the core as an external driver (driver_url pointing at
// that endpoint), so it appears under Integrations exactly like a driver installed on the remote.
//
// IDs: a hosted driver is registered under its REAL driver_id (e.g. "plex_driver"), so the remote,
// its entity IDs ("plex_driver.main.…"), Home Assistant and the Integration Manager all see the
// same names as for a directly installed copy. If that ID is already taken on the remote by
// something that isn't ours (the same integration installed directly, or a built-in one), it falls
// back to "pgs_<id>".
//
// Safety:
//  - Only drivers this bridge registered itself ("owned") are ever changed or deleted. A driver is
//    ours when we registered it, or when it is an external driver pointing at our own endpoint.
//  - An owned driver keeps its remote ID for good: renaming would mean deleting it, and deleting a
//    driver also deletes its entities and their places on activity pages.
//  - A driver is only deleted when the hub reports it as removed (uninstalled there). One that is
//    stopped, crashed or offline is left alone.

import { WebSocket } from "ws";
import { remoteDriverId } from "./linkproto.js";

const PORT_BASE = 9700;
const VALID_ID = /^[A-Za-z0-9_-]{1,36}$/;

export class Registrar {
  /**
   * @param {object} o
   * @param {object} o.state  persisted: { hosted: { <hubId>: { remoteId?, port, name, version } } }
   * @param {function} o.onChange  called with { <hubId>: <remoteId> } whenever registrations change
   */
  constructor({ getCore, tunnels, state, save, log = () => {}, removeOnUninstall = () => true, onChange = () => {}, fetchMetadata = driverMetadata }) {
    this.fetchMetadata = fetchMetadata;
    this.getCore = getCore;
    this.tunnels = tunnels;
    this.state = state;
    this.save = save;
    this.log = log;
    this.removeOnUninstall = removeOnUninstall;
    this.onChange = onChange;
    this.queue = Promise.resolve();
    this.last = { drivers: [], removed: [] };
    this.problems = new Map(); // hubId -> why it isn't on the remote yet
    this.notes = new Map(); // hubId -> something worth knowing (e.g. shown under pgs_ because the ID was taken)
    this.#migrate();
  }

  /** Bridge 0.1.x kept { ports, registered } keyed by "pgs_<hubId>". Those keep their pgs_ IDs. */
  #migrate() {
    this.state.hosted ||= {};
    const { ports, registered } = this.state;
    if (!ports && !registered) return;
    for (const key of new Set([...Object.keys(ports || {}), ...Object.keys(registered || {})])) {
      const hubId = key.startsWith("pgs_") ? key.slice(4) : key;
      const h = (this.state.hosted[hubId] ||= {});
      if (ports?.[key] != null) h.port = ports[key];
      if (registered?.[key]) Object.assign(h, { remoteId: key, name: registered[key].name, version: registered[key].version });
    }
    delete this.state.ports;
    delete this.state.registered;
    this.save();
    this.log(`settings from an older Bridge carried over (${Object.keys(this.state.hosted).length} integrations keep their IDs)`);
  }

  /** Forgets a registration that a move removed on purpose (so it isn't added back). */
  forget(hubId) {
    const h = this.state.hosted[hubId];
    if (h?.remoteId) {
      delete h.remoteId;
      this.save();
      this.onChange(this.mapping());
    }
  }

  /** hubId -> remoteId for everything registered on this remote. */
  mapping() {
    return Object.fromEntries(Object.entries(this.state.hosted).filter(([, h]) => h.remoteId).map(([id, h]) => [id, h.remoteId]));
  }

  /** Opens endpoints for everything registered before (the core may connect before the link is up). */
  async restore() {
    for (const hubId of Object.keys(this.state.hosted)) {
      try {
        await this.#endpoint(hubId);
      } catch (e) {
        this.log(`${hubId}: endpoint failed: ${e.message}`);
      }
    }
  }

  sync(drivers, removed) {
    this.last = { drivers, removed };
    this.queue = this.queue.then(() => this.#sync(drivers, removed)).catch((e) => this.log(`sync: ${e.message}`));
    return this.queue;
  }

  resync() {
    return this.sync(this.last.drivers, this.last.removed);
  }

  summary() {
    return {
      hosted: this.last.drivers.length,
      onRemote: this.last.drivers.filter((d) => this.state.hosted[d.id]?.remoteId).length,
      running: this.last.drivers.filter((d) => d.state === "running").length,
      problems: [...this.problems.entries()],
      notes: [...this.notes.entries()]
    };
  }

  async #endpoint(hubId) {
    const h = (this.state.hosted[hubId] ||= {});
    const port = await this.tunnels.ensure(hubId, h.port ?? this.#nextPort());
    if (h.port !== port) {
      h.port = port;
      this.save();
    }
    return port;
  }

  #nextPort() {
    const used = new Set(Object.values(this.state.hosted).map((h) => h.port));
    let p = PORT_BASE;
    while (used.has(p)) p++;
    return p;
  }

  async #sync(drivers, removed) {
    const core = this.getCore();
    const before = JSON.stringify(this.mapping());
    for (const d of drivers) {
      const hubId = d.id;
      try {
        const port = await this.#endpoint(hubId);
        if (!core) {
          this.problems.set(hubId, "the Bridge has no access to the remote: run its setup again with the web-configurator PIN");
          continue;
        }
        const h = this.state.hosted[hubId];
        // held back by the hub while it moves (to or from the remote): endpoint only, no registration
        if (d.hold) {
          this.problems.delete(hubId);
          this.notes.set(hubId, "moving");
          continue;
        }
        // the core fetches the driver's metadata while registering, so the driver must be up
        if (d.state !== "running") {
          if (!h.remoteId) this.problems.set(hubId, `${d.name} is ${d.state} on the hub`);
          continue;
        }
        const note = await this.#register(core, hubId, d, `ws://127.0.0.1:${port}`);
        if (note) this.notes.set(hubId, note);
        else if (!h.remoteId?.startsWith("pgs_")) this.notes.delete(hubId);
        this.problems.delete(hubId);
      } catch (e) {
        this.problems.set(hubId, e.message);
        this.log(`${hubId}: ${e.message}`);
      }
    }
    if (core) {
      for (const hubId of removed) await this.#unregister(core, hubId);
    }
    if (JSON.stringify(this.mapping()) !== before) this.onChange(this.mapping());
  }

  /** Is this core driver record ours (an external driver pointing at our endpoint)? */
  #ours(existing, url, owned) {
    if (!existing || existing.driver_type !== "EXTERNAL") return false;
    if (existing.driver_url) return existing.driver_url === url || (owned && /^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(existing.driver_url));
    return owned; // record without a URL: trust only our own registrations
  }

  async #get(core, id) {
    try {
      return await core.get(`/intg/drivers/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Registers a driver. The remote's API needs more than its documentation says (it refused a
   * registration without "version"), so the body carries the same fields as Unfolded Circle's own
   * registration example, filled from the driver's own metadata (asked through our endpoint, i.e.
   * exactly what the core will read), falling back to what the hub's catalog says.
   */
  async #post(core, id, d, url) {
    this.log(`${id}: registering with the remote at ${url}`);
    let meta = {};
    try {
      meta = (await this.fetchMetadata(url)) || {};
    } catch (e) {
      this.log(`${id}: could not read the driver's details (${e.message}); using the hub's`);
    }
    await core.post("/intg/drivers", registrationBody(id, url, meta, d));
    this.log(`${id}: registered on the remote (${d.name} ${d.version}) -> ${url}`);
  }

  async #register(core, hubId, d, url) {
    const h = this.state.hosted[hubId];

    if (h.remoteId) {
      const existing = await this.#get(core, h.remoteId);
      if (existing && this.#ours(existing, url, true)) {
        if (existing.driver_url && existing.driver_url !== url) {
          await core.patch(`/intg/drivers/${encodeURIComponent(h.remoteId)}`, { driver_url: url });
          this.log(`${h.remoteId}: endpoint moved to ${url}`);
        }
        this.#remember(h, d);
        return null;
      }
      if (!existing) {
        // gone from the remote (deleted there, or a factory reset): add it back under the same ID
        await this.#post(core, h.remoteId, d, url);
        this.#remember(h, d);
        return null;
      }
      // the ID now belongs to something else (e.g. the integration was installed directly): let go
      this.log(`${h.remoteId}: now used by another integration on the remote; leaving it alone`);
      delete h.remoteId;
      this.save();
    }

    // First registration: the real driver_id if it is free (or already ours), else pgs_<hubId>.
    const real = VALID_ID.test(String(d.driver_id || "")) ? d.driver_id : null;
    const candidates = [...new Set([real, remoteDriverId(hubId)].filter(Boolean))];
    for (const id of candidates) {
      const existing = await this.#get(core, id);
      if (!existing) {
        await this.#post(core, id, d, url);
      } else if (!this.#ours(existing, url, false)) {
        this.log(`${id}: already used on the remote (${existing.driver_type || "unknown"} ${existing.name?.en || ""}), trying another ID`.trim());
        continue;
      }
      h.remoteId = id;
      this.#remember(h, d);
      return id !== real && real ? `shown as ${id}: ${real} is already used on the remote` : null;
    }
    throw new Error(`no free ID on the remote (tried ${candidates.join(", ")})`);
  }

  #remember(h, d) {
    if (h.name !== d.name || h.version !== d.version) {
      h.name = d.name;
      h.version = d.version;
      h.at = Date.now();
      this.save();
    }
  }

  async #unregister(core, hubId) {
    const h = this.state.hosted[hubId];
    if (!h) return;
    if (h.remoteId) {
      if (!this.removeOnUninstall()) return;
      try {
        const existing = await this.#get(core, h.remoteId);
        if (existing && this.#ours(existing, `ws://127.0.0.1:${h.port}`, true)) {
          await core.delete(`/intg/drivers/${encodeURIComponent(h.remoteId)}`);
          this.log(`${h.remoteId}: removed from the remote (uninstalled on the hub)`);
        }
      } catch (e) {
        this.log(`${h.remoteId}: could not remove: ${e.message}`);
        return;
      }
    }
    await this.tunnels.remove(hubId);
    delete this.state.hosted[hubId];
    this.problems.delete(hubId);
    this.notes.delete(hubId);
    this.save();
  }
}

const lang = (v, fallback) => (v && typeof v === "object" && Object.keys(v).length ? v : { en: String((typeof v === "string" && v) || fallback || "") });

/** Body for POST /intg/drivers, shaped like Unfolded Circle's registration example. */
export function registrationBody(id, url, meta, d) {
  const icon = String(meta.icon || d.icon || "");
  const body = {
    driver_id: id,
    name: lang(meta.name, d.name || id),
    driver_url: url,
    version: String(meta.version || d.version || "0.0.0").slice(0, 20),
    icon: /^[a-z][a-z0-9]+:[A-Za-z0-9._-]+$/.test(icon) && !icon.startsWith("custom:") ? icon : "uc:integration",
    enabled: true,
    description: lang(meta.description, ""),
    device_discovery: !!meta.device_discovery,
    setup_data_schema: meta.setup_data_schema && typeof meta.setup_data_schema === "object" ? meta.setup_data_schema : {}
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(meta.release_date || ""))) body.release_date = meta.release_date;
  return body;
}

/** Asks a driver for its metadata over the Integration API (what the core does when registering). */
export function driverMetadata(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    const done = (fn, v) => {
      clearTimeout(t);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn(v);
    };
    const t = setTimeout(() => done(reject, new Error("no answer")), timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ kind: "req", id: 1, msg: "get_driver_metadata" })));
    ws.on("message", (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.kind === "resp" && m.req_id === 1) done(resolve, m.msg_data || {});
    });
    ws.on("error", (e) => done(reject, e));
    ws.on("close", () => done(reject, new Error("closed before answering")));
  });
}
