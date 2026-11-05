// What running integrations on the hub saves the remote's battery: an estimate of the energy each
// integration would use if it ran on the remote (its processor time, scaled to the remote's
// slower processor, and the Wi-Fi traffic to its devices), minus what the remote now spends on
// the link to the hub for it. Memory has no battery cost of its own (the remote's RAM draws the
// same power full or empty), so it's shown as room freed on the remote instead.
//
// Every figure is an assumption the page shows and lets you change; measured drain before and
// after the first move (resources.js batteryComparison) is shown beside it as the check.

import os from "node:os";

/** The assumptions, with where each comes from. */
export function defaultModel(arch = process.arch) {
  return {
    batteryWh: 8.9, // Remote 3: 2400 mAh lithium-ion at ~3.7 V
    // how many times longer the remote's quad-core ARM (Cortex-A55 class) takes for the same work
    // than one core of this server: a typical NAS / PC x86 core is ~5x faster, a Pi 4/5 core ~2x
    cpuSlowdown: arch === "arm64" || arch === "aarch64" ? 2 : 5,
    cpuWattsPerCore: 0.35, // extra power of one busy A55-class core at full clock
    wifiJoulesPerMB: 0.3, // Wi-Fi 5 transfer energy per megabyte
    wifiJoulesPerSend: 0.01, // radio wake-up and tail per packet, averaged over packets sent together
    awakeShareDefault: 0.3, // share of the day the remote is awake, until there are battery readings
    countWhileAsleep: false // integrations on a sleeping remote do little; don't count those hours
  };
}

export function mergeModel(saved = {}, arch) {
  const d = defaultModel(arch);
  const out = { ...d };
  for (const k of Object.keys(d)) {
    if (typeof d[k] === "number" && Number.isFinite(Number(saved[k])) && Number(saved[k]) >= 0) out[k] = Number(saved[k]);
    if (typeof d[k] === "boolean" && typeof saved[k] === "boolean") out[k] = saved[k];
  }
  return out;
}

/**
 * integrations: [{ id, name, cpu (avg % of one hub core), memMB, netBytesPerSec and sendsPerSec
 *                  (TCP traffic to its devices: bytes, packets; null when not measured),
 *                  linkBytesPerSec, linkMsgsPerSec (its traffic over the link to the remote now) }]
 * remote: { awakeShare (0..1 or null), memTotalMB, memUsedMB, drainPerDay (% or null) }
 * bridge: { cpu (% of one remote core) } or null
 * Returns per-integration and total joules and % of battery per day.
 */
export function estimateSavings(integrations, remote = {}, bridge = null, model = defaultModel()) {
  const awake = remote.awakeShare != null ? remote.awakeShare : model.awakeShareDefault;
  const share = model.countWhileAsleep ? 1 : awake;
  const day = 86400 * share; // seconds a day the work would happen on the remote
  const capJ = model.batteryWh * 3600;
  const pct = (j) => (j / capJ) * 100;
  const rows = integrations.map((i) => {
    const cpuJ = ((i.cpu || 0) / 100) * model.cpuSlowdown * model.cpuWattsPerCore * day;
    const devBytes = (i.netBytesPerSec || 0) * day;
    const devSends = (i.sendsPerSec || 0) * day;
    const netJ = (devBytes / 1e6) * model.wifiJoulesPerMB + devSends * model.wifiJoulesPerSend;
    const linkJ = (((i.linkBytesPerSec || 0) * day) / 1e6) * model.wifiJoulesPerMB + (i.linkMsgsPerSec || 0) * day * model.wifiJoulesPerSend;
    const savedJ = cpuJ + netJ - linkJ;
    return {
      id: i.id,
      name: i.name,
      memMB: i.memMB ?? null,
      perDay: {
        cpuJ: r(cpuJ, 0),
        networkJ: r(netJ, 0),
        linkJ: r(linkJ, 0),
        savedJ: r(savedJ, 0),
        savedPct: r(pct(savedJ), 2),
        cpuPct: r(pct(cpuJ), 2),
        networkPct: r(pct(netJ), 2),
        linkPct: r(pct(linkJ), 2)
      },
      inputs: { cpu: r(i.cpu, 2), deviceKBPerMin: i.netBytesPerSec == null ? null : r(((i.netBytesPerSec || 0) * 60) / 1024, 1), packetsPerMin: i.sendsPerSec == null ? null : r((i.sendsPerSec || 0) * 60, 1), linkKBPerMin: r(((i.linkBytesPerSec || 0) * 60) / 1024, 1), linkMsgsPerMin: r((i.linkMsgsPerSec || 0) * 60, 1) }
    };
  });
  // the Bridge itself runs on the remote for all of them
  const bridgeJ = bridge?.cpu != null ? (bridge.cpu / 100) * model.cpuWattsPerCore * day : 0;
  const savedJ = rows.reduce((a, x) => a + x.perDay.savedJ, 0) - bridgeJ;
  const savedPct = pct(savedJ);
  const memMB = rows.reduce((a, x) => a + (x.memMB || 0), 0);
  const drain = remote.drainPerDay; // measured % per day now (with the integrations on the hub)
  return {
    model,
    awakeShare: r(awake, 2),
    awakeShareMeasured: remote.awakeShare != null,
    integrations: rows.sort((a, b) => b.perDay.savedJ - a.perDay.savedJ),
    bridge: { joulesPerDay: r(bridgeJ, 0), pct: r(pct(bridgeJ), 2), cpu: bridge?.cpu ?? null },
    total: {
      savedJ: r(savedJ, 0),
      savedPctPerDay: r(savedPct, 2),
      savedWhPerDay: r(savedJ / 3600, 3),
      // what a charge would last if the integrations were back on the remote, against now
      daysPerChargeNow: drain > 0 ? r(100 / drain, 1) : null,
      daysPerChargeOnRemote: drain > 0 ? r(100 / (drain + Math.max(0, savedPct)), 1) : null,
      extraHoursPerCharge: drain > 0 ? r((100 / drain - 100 / (drain + Math.max(0, savedPct))) * 24, 1) : null
    },
    memory: { freedMB: r(memMB, 0), remoteTotalMB: remote.memTotalMB ?? null, remoteUsedMB: remote.memUsedMB ?? null }
  };
}

export function hostCores() {
  return os.cpus()?.length || 1;
}

const r = (v, d) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
