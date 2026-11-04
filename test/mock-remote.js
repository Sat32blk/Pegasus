// A stand-in for the remote's core, for testing moves. It behaves like Unfolded Circle's API where
// a move depends on it:
//  - POST /intg/install runs custom integrations as real processes (bin/driver.js) with their own
//    config folder; ?update=true replaces the program and KEEPS the config files; a fresh install
//    takes config/ and data/ from the archive
//  - deleting a driver deletes its instances and entities and REMOVES every reference to them from
//    activities (entities, sequences, buttons, pages), macros, home pages and groups
//  - registering an external driver requires driver_url, name and version
//  - a driver's instance is <driver_id>.main; entities are <instance>.<entity id>
//  - listing an instance's entities fails with "Integration is not active" while its driver is down

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { readTarGz } from "../bridge/src/bin/tar.js";

const freePort = () =>
  new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

export async function startMockRemote({ apiKey = "test-key", log = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-mockremote-"));
  const drivers = new Map(); // id -> { meta, type, proc, dir }
  const offers = new Map(); // driver id -> entity ids its driver offers (as the core would load them)
  // entities a driver does not offer (even while selected): "always" = left over from an older
  // version; "external" = only while it runs on the hub (e.g. a device the hub can't reach)
  const notOffered = { always: new Set(), external: new Set() };
  const offerFilter = (inst) => (e) => !notOffered.always.has(e) && !(drivers.get(inst.driver_id)?.type === "EXTERNAL" && notOffered.external.has(e));
  const instances = new Map(); // integration_id -> { integration_id, driver_id, name, icon, configured: [] }
  const entities = new Map(); // entity_id -> { entity_id, integration_id, name, icon, entity_type }
  const activities = new Map();
  const macros = new Map();
  const profiles = [{ profile_id: "p1", name: "Default" }];
  const pages = new Map([["p1", []]]);
  const groups = new Map([["p1", []]]);
  const calls = [];
  let failNext = null; // one-shot fault injection: (method, path) => boolean

  async function runCustom(id) {
    const d = drivers.get(id);
    d.proc?.kill("SIGKILL");
    const bin = path.join(d.dir, "bin");
    const port = await freePort();
    d.port = port;
    d.proc = spawn(process.execPath, ["driver.js"], {
      cwd: bin,
      env: { ...process.env, UC_CONFIG_HOME: path.join(d.dir, "config"), HOME: path.join(d.dir, "config"), UC_DATA_HOME: path.join(d.dir, "data"), UC_INTEGRATION_HTTP_PORT: String(port), UC_INTEGRATION_INTERFACE: "127.0.0.1", UC_DISABLE_MDNS_PUBLISH: "true" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    d.proc.stdout.on("data", (b) => log(`[${id}] ${b.toString().trim()}`));
    d.proc.stderr.on("data", (b) => log(`[${id}!] ${b.toString().trim()}`));
  }

  function install(buf, update) {
    const files = readTarGz(buf);
    const dj = files.find((f) => f.name === "driver.json");
    if (!dj) return [400, { message: "missing driver.json" }];
    const meta = JSON.parse(dj.data.toString());
    const id = meta.driver_id;
    const have = drivers.get(id);
    if (update && (!have || have.type !== "CUSTOM")) return [404, { message: "no custom integration to update" }];
    if (!update && have) return [422, { message: "already installed" }];
    if (!update && [...drivers.values()].filter((x) => x.type === "CUSTOM").length >= 10) return [409, { message: "maximum custom integrations reached" }];
    const dir = have?.dir || path.join(root, id);
    fs.rmSync(path.join(dir, "bin"), { recursive: true, force: true });
    for (const f of files) {
      if (f.type !== "0") continue;
      if (update && /^(config|data)\//.test(f.name)) continue; // existing configuration files are not replaced
      const dest = path.join(dir, f.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data);
    }
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    drivers.set(id, { ...(have || {}), meta, type: "CUSTOM", dir });
    runCustom(id);
    return [200, { driver_id: id }];
  }

  /** Removes every reference to an instance's entities, as the real remote does on driver deletion. */
  function stripRefs(prefix) {
    const keep = (e) => !String(e || "").startsWith(prefix);
    const cmdOk = (c) => !c || keep(c.entity_id);
    for (const a of activities.values()) {
      const o = a.options;
      o.included_entities = (o.included_entities || []).filter((x) => keep(x.entity_id));
      for (const k of ["on", "off"]) if (o.sequences?.[k]) o.sequences[k] = o.sequences[k].filter((s) => s.type !== "command" || cmdOk(s.command));
      o.button_mapping = (o.button_mapping || []).map((m) => ({ button: m.button, ...(cmdOk(m.short_press) && m.short_press ? { short_press: m.short_press } : {}), ...(cmdOk(m.long_press) && m.long_press ? { long_press: m.long_press } : {}) }));
      for (const pg of o.user_interface?.pages || []) pg.items = pg.items.filter((it) => cmdOk(it.command) && keep(it.media_player_id));
    }
    for (const m of macros.values()) {
      m.options.included_entities = (m.options.included_entities || []).filter((x) => keep(x.entity_id));
      m.options.sequence = (m.options.sequence || []).filter((s) => s.type !== "command" || cmdOk(s.command));
    }
    for (const list of pages.values()) for (const pg of list) pg.items = pg.items.filter((i) => keep(i.entity_id));
    for (const list of groups.values()) for (const g of list) g.entities = g.entities.filter(keep);
  }

  function deleteDriver(id) {
    const d = drivers.get(id);
    if (!d) return false;
    d.proc?.kill("SIGKILL");
    for (const [iid, inst] of instances) {
      if (inst.driver_id !== id) continue;
      offers.set(id, [...new Set([...(offers.get(id) || []), ...inst.configured])]);
      instances.delete(iid);
      for (const eid of [...entities.keys()]) if (eid.startsWith(iid + ".")) entities.delete(eid);
      stripRefs(iid + ".");
    }
    if (d.dir) fs.rmSync(d.dir, { recursive: true, force: true });
    drivers.delete(id);
    return true;
  }

  const driverView = (id) => {
    const d = drivers.get(id);
    return { ...d.meta, driver_id: id, driver_type: d.type, driver_state: "ACTIVE", ...(d.type === "EXTERNAL" ? { driver_url: d.meta.driver_url } : {}) };
  };
  /** Whether a driver's program answers (custom: its process; external: its URL takes a connection). */
  const active = (id) => {
    const d = drivers.get(id);
    if (!d) return Promise.resolve(false);
    if (d.type === "CUSTOM") return Promise.resolve(!!d.proc && d.proc.exitCode === null);
    // like the core's own session with an external driver: it has to answer, not just accept
    return new Promise((r) => {
      let ws;
      const done = (ok) => {
        clearTimeout(t);
        try { ws?.terminate(); } catch {}
        r(ok);
      };
      const t = setTimeout(() => done(false), 1500);
      try {
        ws = new WebSocket(d.meta.driver_url || "ws://127.0.0.1:1");
      } catch {
        return done(false);
      }
      ws.on("open", () => ws.send(JSON.stringify({ kind: "req", id: 1, msg: "get_driver_version" })));
      ws.on("message", (m) => {
        try {
          const j = JSON.parse(m);
          if (j.kind === "resp" && j.req_id === 1) done(true);
        } catch {}
      });
      ws.on("error", () => done(false));
      ws.on("close", () => done(false));
    });
  };
  const paged = (list, url) => {
    const limit = Number(url.searchParams.get("limit") || 100);
    const page = Number(url.searchParams.get("page") || 1);
    return list.slice((page - 1) * limit, page * limit);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { message: "unauthorized" });
    const body = () => (raw.length && !String(req.headers["content-type"]).startsWith("multipart") ? JSON.parse(raw.toString()) : undefined);
    const p = url.pathname.replace(/^\/api/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const M = req.method;
    calls.push(`${M} ${url.pathname}${url.search}`);
    if (failNext && failNext(M, url.pathname)) {
      failNext = null;
      return send(500, { message: "injected failure" });
    }
    try {
      // ---- integrations
      if (p[0] === "intg" && p[1] === "install" && M === "POST") {
        const form = await new Response(raw, { headers: { "content-type": req.headers["content-type"] } }).formData();
        const file = form.get("file");
        const [code, out] = install(Buffer.from(await file.arrayBuffer()), url.searchParams.get("update") === "true");
        return send(code, out);
      }
      if (p[0] === "intg" && p[1] === "drivers") {
        // like the real core, the list is a summary: no home_page, developer is just a name
        if (!p[2] && M === "GET") return send(200, paged([...drivers.keys()].map(driverView).map(({ home_page, developer, setup_data_schema, ...rest }) => ({ ...rest, developer: developer?.name ?? developer ?? null })), url));
        if (!p[2] && M === "POST") {
          const b = body();
          for (const f of ["driver_url", "name", "version"]) if (!b[f]) return send(400, { message: `Missing field: ${f}` });
          if (drivers.has(b.driver_id)) return send(422, { message: "driver_id in use" });
          drivers.set(b.driver_id, { meta: b, type: "EXTERNAL" });
          return send(201, driverView(b.driver_id));
        }
        const id = p[2];
        if (!drivers.has(id)) return send(404, { message: "not found" });
        if (M === "GET") return send(200, driverView(id));
        if (M === "PATCH") {
          Object.assign(drivers.get(id).meta, body());
          return send(200, driverView(id));
        }
        if (M === "DELETE") {
          deleteDriver(id);
          return send(200, {});
        }
        if (M === "POST") {
          const iid = `${id}.main`;
          if (instances.has(iid)) return send(422, { message: "instance exists" });
          const b = body() || {};
          const inst = { integration_id: iid, driver_id: id, name: b.name || drivers.get(id).meta.name, icon: b.icon, enabled: true, device_state: "CONNECTED", configured: [] };
          instances.set(iid, inst);
          return send(201, inst);
        }
      }
      if (p[0] === "intg" && p[1] === "instances") {
        if (!p[2]) return send(200, paged([...instances.values()].map(({ configured, ...i }) => i), url));
        const inst = instances.get(p[2]);
        if (!inst) return send(404, { message: "not found" });
        if (!p[3] && M === "GET") return send(200, (({ configured, ...i }) => i)(inst));
        if (p[3] === "entities" && M === "GET") {
          // like the real core: listing needs the integration to be running ("Integration is not active")
          if (!(await active(inst.driver_id))) return send(400, { code: "BAD_REQUEST", message: "Integration is not active" });
          // and the driver's entity list is only known after a reload (or earlier use)
          if (url.searchParams.get("reload") === "true") inst.loaded = true;
          const offered = (inst.loaded || inst.configured.length ? [...new Set([...(offers.get(inst.driver_id) || []), ...inst.configured])] : []).filter(offerFilter(inst));
          const filter = url.searchParams.get("filter") || "NEW";
          const list = filter === "CONFIGURED" ? inst.configured : filter === "ALL" ? offered : offered.filter((e) => !inst.configured.includes(e));
          return send(200, paged(list.map((e) => ({ entity_id: e })), url));
        }
        if (p[3] === "entities" && M === "POST") {
          // like the real core: the driver's own entity IDs, only ones it has loaded; others are ignored
          const offered = (inst.loaded ? offers.get(inst.driver_id) || [] : []).filter(offerFilter(inst));
          for (const e of body() || []) {
            if (typeof e !== "string" || !offered.includes(e)) continue;
            if (!inst.configured.includes(e)) inst.configured.push(e);
            const full = `${inst.integration_id}.${e}`;
            if (!entities.has(full)) entities.set(full, { entity_id: full, integration_id: inst.integration_id, name: { en: e }, entity_type: "switch" });
          }
          return send(200, []);
        }
      }
      // ---- entities
      if (p[0] === "entities") {
        if (!p[1]) return send(200, paged([...entities.values()], url));
        const e = entities.get(p[1]);
        if (!e) return send(404, { message: "not found" });
        if (M === "GET") return send(200, e);
        if (M === "PATCH") {
          Object.assign(e, body());
          return send(200, e);
        }
      }
      // ---- activities
      if (p[0] === "activities") {
        if (!p[1]) return send(200, paged([...activities.values()].map((a) => ({ entity_id: a.entity_id, name: a.name })), url));
        const a = activities.get(p[1]);
        if (!a) return send(404, { message: "not found" });
        if (!p[2] && M === "GET") return send(200, a);
        if (!p[2] && M === "PATCH") {
          const o = body().options || {};
          if (o.entity_ids) {
            for (const e of o.entity_ids) if (!entities.has(e) && !e.startsWith("other.")) return send(400, { message: `unknown entity ${e}` });
            a.options.included_entities = o.entity_ids.map((entity_id) => ({ entity_id }));
          }
          for (const k of ["sequences", "touch_slider", "voice_assistant"]) if (o[k]) a.options[k] = o[k];
          return send(200, a);
        }
        if (p[2] === "buttons" && M === "PATCH") {
          const m = a.options.button_mapping.find((x) => x.button === p[3]) || (a.options.button_mapping.push({ button: p[3] }), a.options.button_mapping.at(-1));
          Object.assign(m, body());
          return send(200, m);
        }
        if (p[2] === "ui" && p[3] === "pages" && p[4] && M === "PATCH") {
          const pg = a.options.user_interface.pages.find((x) => x.page_id === p[4]);
          if (!pg) return send(404, { message: "no page" });
          pg.items = body().items;
          return send(200, pg);
        }
      }
      // ---- macros
      if (p[0] === "macros") {
        if (!p[1]) return send(200, paged([...macros.values()].map((m) => ({ entity_id: m.entity_id, name: m.name })), url));
        const m = macros.get(p[1]);
        if (!m) return send(404, { message: "not found" });
        if (M === "GET") return send(200, m);
        if (M === "PATCH") {
          const o = body().options || {};
          if (o.entity_ids) m.options.included_entities = o.entity_ids.map((entity_id) => ({ entity_id }));
          if (o.sequence) m.options.sequence = o.sequence;
          return send(200, m);
        }
      }
      // ---- home screen
      if (p[0] === "profiles") {
        if (!p[1]) return send(200, profiles);
        if (p[2] === "pages" && !p[3]) return send(200, pages.get(p[1]) || []);
        if (p[2] === "groups" && !p[3]) return send(200, groups.get(p[1]) || []);
        if (p[2] === "pages" && M === "PATCH") {
          const pg = (pages.get(p[1]) || []).find((x) => x.page_id === p[3]);
          pg.items = body().items.map((i, pos) => ({ ...i, pos }));
          return send(200, pg);
        }
        if (p[2] === "groups" && M === "PATCH") {
          const g = (groups.get(p[1]) || []).find((x) => x.group_id === p[3]);
          g.entities = body().entities;
          return send(200, g);
        }
      }
      // ---- power (battery tracker)
      if (p[0] === "system" && p[1] === "power") {
        if (p[2] === "battery") return send(200, { capacity: 88, status: "DISCHARGING", power_supply: false });
        if (!p[2]) return send(200, { mode: "NORMAL", power_supply: false, standby_inhibitors: false });
        return send(200, []);
      }
      send(404, { message: `mock: no route for ${M} ${url.pathname}` });
    } catch (e) {
      send(500, { message: e.message });
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  return {
    port: server.address().port,
    drivers,
    instances,
    entities,
    activities,
    macros,
    pages,
    groups,
    calls,
    root,
    install,
    notOffered,
    failOnce(fn) {
      failNext = fn;
    },
    async stop() {
      for (const d of drivers.values()) d.proc?.kill("SIGKILL");
      await new Promise((r) => server.close(r));
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
