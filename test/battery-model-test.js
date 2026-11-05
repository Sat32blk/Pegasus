// The battery estimate (what integrations on the hub would cost the remote's battery), the TCP
// traffic meter it uses, and what integrations learn about running on the hub (developer hints).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateSavings, defaultModel, mergeModel } from "../hub/src/batterymodel.js";
import { parseSs } from "../hub/src/netusage.js";
import { startHub } from "../hub/src/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const step = (s) => console.log("▶ " + s);
let failed = false;
let hub = null;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-bm-"));
try {
  step("the estimate adds processor and Wi-Fi energy, and takes off what the link costs now");
  {
    const m = { ...defaultModel("x64"), awakeShareDefault: 0.5 };
    const e = estimateSavings(
      [{ id: "a", name: "A", cpu: 1, memMB: 50, netBytesPerSec: 1000, sendsPerSec: 1, linkBytesPerSec: 100, linkMsgsPerSec: 0.1 }],
      { awakeShare: null, drainPerDay: 20 },
      { cpu: 0.2 },
      m
    );
    const day = 86400 * 0.5;
    const cpuJ = 0.01 * m.cpuSlowdown * m.cpuWattsPerCore * day;
    const netJ = ((1000 * day) / 1e6) * m.wifiJoulesPerMB + day * m.wifiJoulesPerSend;
    const linkJ = ((100 * day) / 1e6) * m.wifiJoulesPerMB + 0.1 * day * m.wifiJoulesPerSend;
    const bridgeJ = 0.002 * m.cpuWattsPerCore * day;
    assert.equal(e.integrations[0].perDay.cpuJ, Math.round(cpuJ));
    assert.equal(e.integrations[0].perDay.networkJ, Math.round(netJ));
    assert.equal(e.integrations[0].perDay.linkJ, Math.round(linkJ));
    assert.equal(e.total.savedJ, Math.round(Math.round(cpuJ + netJ - linkJ) - bridgeJ));
    const pct = (e.total.savedJ / (m.batteryWh * 3600)) * 100;
    assert.ok(Math.abs(e.total.savedPctPerDay - pct) < 0.01);
    assert.equal(e.total.daysPerChargeNow, 5);
    assert.ok(e.total.daysPerChargeOnRemote < 5 && e.total.extraHoursPerCharge > 0);
    assert.equal(e.memory.freedMB, 50);
    console.log(`  ${e.total.savedPctPerDay}% a day, +${e.total.extraHoursPerCharge} h per charge`);
  }

  step("assumptions can be changed, and bad values fall back to the defaults");
  {
    const m = mergeModel({ cpuSlowdown: 3, batteryWh: -1, wifiJoulesPerMB: "x" }, "arm64");
    assert.equal(m.cpuSlowdown, 3);
    assert.equal(m.batteryWh, defaultModel().batteryWh);
    assert.equal(m.wifiJoulesPerMB, defaultModel().wifiJoulesPerMB);
    assert.equal(defaultModel("arm64").cpuSlowdown, 2);
    console.log("  ok");
  }

  step("TCP traffic to devices is counted from ss; local connections (the link) are not");
  {
    const out = parseSs(
      "ESTAB 0 0 127.0.0.1:10100 127.0.0.1:5555 ino:42 bytes_sent:10 bytes_received:5 data_segs_out:2 data_segs_in:1\n" +
        "ESTAB 0 0 [::ffff:192.0.2.2]:40000 [::ffff:192.0.2.9]:8001 timer:(keepalive,1sec,0) ino:43 sk:1 bytes_sent:100 bytes_acked:101 bytes_received:50 data_segs_out:3 data_segs_in:4\n"
    );
    assert.deepEqual(out, [
      { ino: "42", local: true, bytes: 15, packets: 3 },
      { ino: "43", local: false, bytes: 150, packets: 7 }
    ]);
    console.log("  ok");
  }

  step("integrations learn they run on the hub; the hub's own settings stay out of their environment");
  {
    process.env.PEGASUS_PASSWORD = "secret-for-the-page";
    hub = await startHub({ port: 0, dataDir, quiet: true, password: "secret-for-the-page" });
    const job = hub.mgr.install({ local: path.join(HERE, "fixtures", "sim-node") });
    while (job.state === "running") await new Promise((r) => setTimeout(r, 300));
    assert.equal(job.state, "done", job.error);
    let pid = null;
    for (let i = 0; i < 60 && !pid; i++) {
      pid = hub.sup.info("sim_node").pid;
      await new Promise((r) => setTimeout(r, 300));
    }
    const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(env.PEGASUS_HUB, "1");
    assert.equal(env.PEGASUS_LIMITS, "relaxed");
    assert.match(env.PEGASUS_HUB_API, /^http:\/\/127\.0\.0\.1:\d+\/api\/hubinfo$/);
    assert.ok(Number(env.PEGASUS_CPU_CORES) >= 1);
    assert.equal(env.PEGASUS_PASSWORD, undefined, "the page password leaked into an integration");
    const info = await fetch(env.PEGASUS_HUB_API).then((r) => r.json());
    assert.equal(info.runtime, "pegasus-hub");
    assert.equal(info.limits.battery, false);
    const st = await fetch(`http://127.0.0.1:${hub.port}/api/status`);
    assert.equal(st.status, 401, "the rest of the API still needs the password");
    console.log(`  PEGASUS_HUB=1, limits relaxed, ${info.host.cores} cores; /api/hubinfo open from this machine, the rest needs the password`);
  }
  console.log("\nBATTERY MODEL & HOOKS: all passed");
} catch (e) {
  failed = true;
  console.error("\nBATTERY MODEL & HOOKS FAILED:", e.stack || e.message);
} finally {
  delete process.env.PEGASUS_PASSWORD;
  if (hub) await hub.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
