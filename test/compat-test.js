// Old and new together: a Bridge from before resume (0.4.x) with this hub, and this Bridge with a
// hub from before resume (0.11.x). Needs the older tree: PEGASUS_OLD_TREE=<checkout of a 0.11 tag>.
//   git worktree add /tmp/old v0.4.7 && PEGASUS_OLD_TREE=/tmp/old node test/compat-test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const OLD = process.env.PEGASUS_OLD_TREE;
if (!OLD || !fs.existsSync(path.join(OLD, "hub", "src", "server.js"))) {
  console.log("compat-test: skipped (set PEGASUS_OLD_TREE to a checkout of the previous release)");
  process.exit(0);
}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const load = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A stand-in integration: answers every request with a result. */
function fakeDriver() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let conns = 0;
  wss.on("connection", (ws) => {
    conns++;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.kind === "req") ws.send(JSON.stringify({ kind: "resp", req_id: m.id, code: 200, msg: "result", msg_data: {} }));
    });
  });
  return new Promise((r) => wss.on("listening", () => r({ wss, port: wss.address().port, conns: () => conns })));
}

async function run(label, hubRoot, bridgeRoot, expectResume) {
  const { startHub } = await load(hubRoot, "hub/src/server.js");
  const { LinkClient } = await load(bridgeRoot, "bridge/src/bin/link.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-compat-"));
  const hub = await startHub({ port: 0, dataDir, quiet: true });
  const drv = await fakeDriver();
  // an installed integration that is "running" on the fake driver's port
  hub.store.list = () => [{ id: "fake", driverId: "fake", name: "Fake", version: "1", port: drv.port }];
  hub.store.get = (id) => (id === "fake" ? hub.store.list()[0] : null);
  hub.sup.info = () => ({ state: "running" });
  const logs = [];
  const link = new LinkClient({ hub: `127.0.0.1:${hub.port}`, token: hub.store.hub.token, remote: "compat-remote", version: "t", log: (...a) => logs.push(a.join(" ")) });
  try {
    link.start();
    await until(() => link.up, 5000, "link up");
    let answers = 0;
    let closed = null;
    const open = () => link.open("fake", { onText: () => answers++, onClose: (code) => (closed = code) });
    let ch = open();
    ch.sendText(Buffer.from(JSON.stringify({ kind: "req", id: 1, msg: "get_driver_version" })));
    await until(() => answers === 1, 3000, "answer through the link");
    // the link is checked in on and stays up while quiet (old hubs drop a link silent for 20 s)
    link.setStandby(true);
    await until(() => hub.link.status()[0]?.standby === true, 3000, "standby seen");
    link.setStandby(false);
    await until(() => hub.link.status()[0]?.standby === false, 3000, "wake seen");
    await sleep(22000);
    assert.ok(link.up && closed === null, "the link dropped while quiet");
    // the connection drops
    const before = link.ws;
    for (const l of hub.link.links) l.ws.terminate();
    await until(() => link.up && link.ws !== before, 8000, "link back on a new connection");
    if (expectResume) {
      assert.equal(closed, null, "sessions should have carried on");
    } else {
      await until(() => closed !== null, 3000, "session closed");
      assert.equal(closed, 1012);
      ch = open();
    }
    ch.sendText(Buffer.from(JSON.stringify({ kind: "req", id: 2, msg: "get_driver_version" })));
    await until(() => answers === 2, 3000, "answer after the drop");
    assert.equal(drv.conns(), expectResume ? 1 : 2);
    console.log(`  ✓ ${label}: links, answers, stays up 22 s quiet, ${expectResume ? "resumes after a drop" : "starts sessions again after a drop"}`);
  } finally {
    link.stop();
    await hub.stop();
    drv.wss.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

let failed = false;
try {
  const NEW = path.join(HERE, "..");
  await run("this hub + this Bridge", NEW, NEW, true);
  await run("this hub + Bridge from the previous release", NEW, OLD, false);
  await run("hub from the previous release + this Bridge", OLD, NEW, false);
  console.log("compat-test: ok");
} catch (e) {
  failed = true;
  console.error("compat-test FAILED:", e.stack || e.message);
}
process.exit(failed ? 1 : 0);
