// Finding integrations' own management pages: the ports their processes listen on, open to the
// network, that answer with HTML (not the remote's port, not 127.0.0.1-only, not JSON APIs).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebPages } from "../hub/src/webpages.js";

const ports = { driver: 0, page: 0, local: 0, api: 0 };
// a stand-in integration: its child process opens the ports (pages often live in a child)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-web-"));
const file = path.join(dir, "intg.cjs");
fs.writeFileSync(file, `
const http = require("http");
const { spawn } = require("child_process");
if (process.argv[2] === "child") {
  const out = {};
  const mk = (name, host, type) => new Promise((r) => { const s = http.createServer((q, res) => { res.writeHead(200, { "content-type": type }); res.end(type.includes("html") ? "<html></html>" : "{}"); }); s.listen(0, host, () => { out[name] = s.address().port; r(); }); });
  Promise.all([mk("driver", "0.0.0.0", "text/html"), mk("page", "0.0.0.0", "text/html; charset=utf-8"), mk("local", "127.0.0.1", "text/html"), mk("api", "0.0.0.0", "application/json")]).then(() => console.log(JSON.stringify(out)));
} else {
  spawn(process.execPath, [__filename, "child"], { stdio: ["ignore", "inherit", "inherit"] });
  setInterval(() => {}, 1000);
}`);
const parent = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "inherit"], detached: true });
let failed = false;
try {
  const got = await new Promise((r, j) => { parent.stdout.once("data", (d) => r(JSON.parse(d))); setTimeout(() => j(new Error("no ports")), 5000); });
  Object.assign(ports, got);
  const sup = { info: () => ({ pid: parent.pid }), on() {} };
  const store = { list: () => [{ id: "x", port: ports.driver }] };
  const w = new WebPages({ sup, store });
  await w.scan();
  w.close();
  assert.deepEqual(w.of("x"), [{ port: ports.page, path: "/" }]);
  console.log(`▶ only the web page on an open port counts (page ${ports.page}; not the driver's port, a 127.0.0.1-only page or a JSON API)`);
  const none = new WebPages({ sup: { info: () => ({ pid: null }), on() {} }, store });
  await none.scan();
  none.close();
  assert.deepEqual(none.of("x"), []);
  console.log("▶ a stopped integration has none");
  console.log("\nWEBPAGES: all passed");
} catch (e) {
  failed = true;
  console.error("WEBPAGES FAILED:", e.stack || e.message);
} finally {
  try { process.kill(-parent.pid); } catch {}
  try { parent.kill("SIGKILL"); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
