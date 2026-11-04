// The Unfolded Circle integration catalog (the list the community Integration Manager uses):
// driver ID -> GitHub repository, for integrations whose driver.json doesn't link their source.
// Fetched at most twice a day; the last copy is kept in memory.

const URL_ = process.env.PEGASUS_CATALOG_URL || "https://raw.githubusercontent.com/JackJPowell/uc-intg-list/refs/heads/main/registry.json";
const TTL = 12 * 3600e3;
let cache = null; // { at, byDriver: Map }
let pending = null;

async function load() {
  if (cache && Date.now() - cache.at < TTL) return cache.byDriver;
  if (!pending) {
    pending = (async () => {
      try {
        const r = await fetch(URL_, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "pegasus-hub" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const list = Array.isArray(j) ? j : j.integrations || [];
        const byDriver = new Map();
        for (const x of list) if (x?.driver_id && /github\.com\//.test(x.repository || "")) byDriver.set(String(x.driver_id), String(x.repository));
        cache = { at: Date.now(), byDriver };
      } catch {
        if (!cache) cache = { at: Date.now() - TTL + 600e3, byDriver: new Map() }; // retry in 10 min
      } finally {
        pending = null;
      }
      return cache.byDriver;
    })();
  }
  return pending;
}

/** { driverId: "https://github.com/owner/repo" } for the ones the catalog knows. */
export async function catalogRepos(driverIds) {
  const m = await load();
  const out = {};
  for (const id of driverIds) if (m.has(id)) out[id] = m.get(id);
  return out;
}

/** For tests. */
export function _setCatalog(entries) {
  cache = { at: Date.now(), byDriver: new Map(Object.entries(entries)) };
}
