// Pegasis Hub: hosts Unfolded Circle integration drivers in a container and serves them to the
// Pegasis Bridge on the remote over one fast multiplexed link.
//
//   http://<host>:9600/          management page
//   http://<host>:9600/api/...   REST API used by the page
//   ws://<host>:9600/link        the link (Bridge connects here)

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { Supervisor } from "./supervisor.js";
import { Manager } from "./manager.js";
import { LinkServer } from "./linkserver.js";
import { InstallError } from "./installer.js";
import { hostArch, readJson } from "./util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// PEGASIS_VERSION is set by the image build (release tag, or dev-<commit> for main-branch builds)
const VERSION = process.env.PEGASIS_VERSION || readJson(path.join(HERE, "..", "package.json"), {}).version || "0.0.0";
const PORT = Number(process.env.PEGASIS_PORT || 9600);
const DATA = process.env.PEGASIS_DATA || "/data";
const PASSWORD = process.env.PEGASIS_PASSWORD || "";
const UPDATE_CHECK_MS = 6 * 3600 * 1000;

const log = (...a) => console.log(new Date().toISOString(), "[hub]", ...a);

export async function startHub({ port = PORT, dataDir = DATA, password = PASSWORD, quiet = false } = {}) {
  const say = quiet ? () => {} : log;
  const store = new Store(dataDir);
  const sup = new Supervisor({ store, log: say });
  const scrubbed = sup.scrubLogs();
  if (scrubbed) say(`masked API keys, passwords and tokens in ${scrubbed} older log file(s)`);
  const mgr = new Manager({ store, supervisor: sup, log: say });
  const link = new LinkServer({ store, supervisor: sup, version: VERSION, log: say });

  sup.on("change", (id, state) => {
    if (state === "crashed" || state === "stopped") link.dropDriver(id);
    link.catalogChanged();
  });
  mgr.on("changed", () => link.catalogChanged());

  const page = () => fs.readFileSync(path.join(HERE, "web", "index.html"));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (password && !authOk(req, password)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Pegasis Hub"' });
        return res.end("Login required");
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(page());
      }
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, e instanceof InstallError ? 400 : 500, { error: e.message });
    }
  });

  async function api(req, res, url) {
    const p = url.pathname.slice(4).split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method;

    if (m === "GET" && p[0] === "status") {
      return send(res, 200, {
        version: VERSION,
        arch: hostArch(),
        pairing: { token: store.hub.token, port: server.address().port },
        remotes: link.status(),
        integrations: store.list().length
      });
    }
    if (m === "GET" && p[0] === "remotes" && p[1] && p[2] === "log") {
      const lines = link.bridgeLog(p[1]);
      return lines ? send(res, 200, { lines }) : send(404, { error: "that remote is not linked" });
    }
    if (m === "POST" && p[0] === "pairing" && p[1] === "regenerate") {
      const token = store.regenerateToken();
      link.disconnectAll(4003, "pairing code changed"); // bridges must re-pair
      return send(res, 200, { token });
    }
    if (p[0] === "jobs" && p[1] && m === "GET") {
      const j = mgr.jobInfo(p[1]);
      return j ? send(res, 200, j) : send(res, 404, { error: "no such job" });
    }
    if (p[0] === "integrations") {
      if (!p[1] && m === "GET") return send(res, 200, store.list().map((meta) => view(meta)));
      if (!p[1] && m === "POST") {
        const body = await readBody(req, 64 * 1024);
        const b = JSON.parse(body.toString() || "{}");
        if (b.local && process.env.PEGASIS_ALLOW_LOCAL !== "1") throw new InstallError("Installing from a local folder is disabled");
        const job = mgr.install({ git: b.url, ref: b.ref, local: b.local });
        return send(res, 202, { job: job.id });
      }
      if (p[1] === "upload" && m === "POST") {
        const buf = await readBody(req, 300 * 1024 * 1024);
        const job = mgr.install({ archive: buf, filename: url.searchParams.get("name") || "upload.tar.gz" });
        return send(res, 202, { job: job.id });
      }
      if (p[1] === "check-updates" && m === "POST") {
        await mgr.checkUpdates();
        return send(res, 200, store.list().map((meta) => view(meta)));
      }
      const id = p[1];
      const meta = store.get(id);
      if (!meta) return send(res, 404, { error: "unknown integration" });
      if (!p[2] && m === "GET") return send(res, 200, view(meta));
      if (!p[2] && m === "PATCH") {
        const b = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}");
        const updated = await mgr.setOptions(id, b);
        return send(res, 200, view(updated));
      }
      if (!p[2] && m === "DELETE") {
        link.dropDriver(id);
        await mgr.remove(id);
        return send(res, 200, { removed: id });
      }
      if (p[2] === "logs" && m === "GET") return send(res, 200, { lines: sup.logs(id) });
      if (m === "POST" && p[2] === "start") {
        await sup.start(id);
        return send(res, 200, view(meta));
      }
      if (m === "POST" && p[2] === "stop") {
        await sup.stop(id);
        return send(res, 200, view(meta));
      }
      if (m === "POST" && p[2] === "restart") {
        link.dropDriver(id);
        await sup.restart(id);
        return send(res, 200, view(meta));
      }
      if (m === "POST" && p[2] === "update") {
        const job = mgr.update(id);
        return send(res, 202, { job: job.id });
      }
    }
    send(res, 404, { error: "not found" });
  }

  function view(meta) {
    return { ...meta, status: sup.info(meta.id), shownAs: link.shownAs(meta.id) };
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/link") return link.handleUpgrade(req, socket, head);
    socket.destroy();
  });

  await new Promise((r) => server.listen(port, "0.0.0.0", r));
  say(`Pegasis Hub ${VERSION} on port ${server.address().port} (${hostArch()}), data in ${dataDir}`);
  say(`pairing code: ${store.hub.token}`);

  for (const meta of store.list()) if (meta.autostart) sup.start(meta.id).catch((e) => say(`start ${meta.id}: ${e.message}`));

  const updTimer = setInterval(() => mgr.checkUpdates().catch(() => {}), UPDATE_CHECK_MS);
  setTimeout(() => mgr.checkUpdates().catch(() => {}), 30000).unref();
  updTimer.unref();

  const stop = async () => {
    clearInterval(updTimer);
    link.close();
    await sup.stopAll();
    await new Promise((r) => server.close(r));
  };
  return { server, store, sup, mgr, link, port: server.address().port, stop };
}

function send(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(new InstallError("Upload too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function authOk(req, password) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = crypto.createHash("sha256").update(pass).digest();
  const b = crypto.createHash("sha256").update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hub = await startHub();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.once(sig, async () => {
      log("shutting down");
      await hub.stop();
      process.exit(0);
    });
  }
}
