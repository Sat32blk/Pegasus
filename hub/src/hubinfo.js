// What the hub tells the integrations it runs (for their developers: DEVELOPERS.md). An
// integration finds it in its environment at start (PEGASUS_*), in the file PEGASUS_HUB_INFO
// (kept up to date), or at PEGASUS_HUB_API (GET, from the hub's own machine).

import os from "node:os";
import fs from "node:fs";

export const INFO_FORMAT = 1;

export function buildHubInfo({ version, port, remotes = [], battery = null }) {
  let memTotalMB = os.totalmem() / 1048576;
  let memAvailMB = os.freemem() / 1048576;
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(mi)?.[1]) / 1024;
    if (kb("MemTotal")) memTotalMB = kb("MemTotal");
    if (kb("MemAvailable")) memAvailMB = kb("MemAvailable");
  } catch {
    /* not Linux */
  }
  return {
    format: INFO_FORMAT,
    runtime: "pegasus-hub",
    version: String(version),
    port,
    host: { arch: process.arch, cores: os.cpus()?.length || 1, memTotalMB: Math.round(memTotalMB), memAvailableMB: Math.round(memAvailMB) },
    // what's different from running on the remote
    limits: {
      relaxed: true,
      battery: false, // mains powered: polling, keep-alive connections and background work cost no battery
      alwaysOn: true, // keeps running while the remote sleeps (its events are held and delivered on wake)
      memoryMB: Math.round(memAvailMB), // free memory on the hub now (the remote has far less)
      installSlots: false, // doesn't use one of the remote's 10 slots
      artworkResized: true // the hub scales artwork links down for the remote's screen
    },
    remotes: remotes.map((r) => {
      const last = battery ? battery.samples(r.remote).at(-1) : null;
      return {
        name: r.remote,
        address: r.address || null, // the remote's own address: use it instead of 127.0.0.1
        asleep: !!r.standby,
        battery: last && typeof last.level === "number" ? { level: last.level, charging: !!last.charging } : null
      };
    })
  };
}
