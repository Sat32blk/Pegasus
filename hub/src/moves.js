// Hub side of moving integrations between a remote and the hub (requests from the Bridge).
//
//   move.prepare       install the same version from GitHub, held back from the remote, not started
//   move.saveSnapshot  keep a copy of the Bridge's snapshot (references to the integration's entities)
//   move.importSettings put the integration's config / data files in place, start it, wait until up
//   move.release       stop holding it back: the Bridge registers it on the remote
//   move.prepareBack   hold it back, stop it, build the remote's release archive with its current
//                      config and data packed in
//   move.chunk         hand that archive to the Bridge in pieces
//   move.finishBack    remove it from the hub (it's back on the remote)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { run, sleep } from "./util.js";
import { InstallError } from "./installer.js";

export function registerMoveHandlers({ link, store, sup, mgr, log, sources = {} }) {
  // where code comes from (replaceable in tests): the GitHub tag for a version, and its release archive
  const sourceFor = sources.prepare || (async ({ homePage, version }) => {
    const repo = githubRepo(homePage);
    if (!repo) throw new Error(`no GitHub repository in ${homePage}`);
    const url = `https://github.com/${repo}.git`;
    return { git: url, ref: await tagFor(url, version) };
  });
  const fetchRelease = sources.release || (async (m, file) => {
    const repo = githubRepo(m.source?.url || m.homePage);
    if (!repo) throw new Error(`${m.name} wasn't installed from GitHub, so the hub can't get the remote's release of it`);
    const asset = await releaseAsset(repo, m.version, m.source?.ref);
    log(`move back: ${m.name} ${m.version}: downloading ${asset.name}`);
    await download(asset.url, file);
  });
  const meta = (hubId) => {
    const m = store.get(hubId);
    if (!m) throw new Error(`${hubId} is not on the hub`);
    return m;
  };
  const setHold = (m, hold) => {
    m.hold = hold;
    store.put(m);
    link.catalogChanged();
  };

  link.handle("move.prepare", async ({ driverId, version, homePage }) => {
    const src = await sourceFor({ driverId, version, homePage });
    log(`move: installing ${driverId} ${version} from ${src.git || src.local}${src.ref ? ` (${src.ref})` : ""}`);
    const job = mgr.install({ ...src, hold: true, noStart: true, expectDriverId: driverId });
    while (job.state === "running") await sleep(500);
    if (job.state !== "done") throw new Error(`the hub could not install it: ${job.error}`);
    const m = meta(job.result.id);
    if (!m.hold) setHold(m, true);
    return { hubId: m.id, version: m.version, runtime: m.runtime };
  });

  link.handle("move.saveSnapshot", async ({ hubId, snapshot }) => {
    const dir = path.join(store.dir(hubId), "move-snapshots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`), JSON.stringify(snapshot));
    return { ok: true };
  });

  link.handle("move.importSettings", async ({ hubId, config = [], data = [] }) => {
    const m = meta(hubId);
    await sup.stop(hubId);
    writeTree(store.configDir(hubId), config);
    writeTree(m.ownDataDir ? store.dataDirOf(hubId) : store.configDir(hubId), data);
    sup.note(hubId, `settings from the remote put in place (${config.length} config, ${data.length} data files)`);
    await sup.start(hubId);
    const until = Date.now() + 90000;
    while (sup.info(hubId).state !== "running") {
      if (Date.now() > until) throw new Error(`${m.name} did not start on the hub with the remote's settings (see its log on the hub page)`);
      await sleep(500);
    }
    return { ok: true };
  });

  link.handle("move.release", async ({ hubId }) => {
    setHold(meta(hubId), false);
    return { ok: true };
  });

  link.handle("move.prepareBack", async ({ hubId }) => {
    const m = meta(hubId);
    setHold(m, true);
    await sup.stop(hubId);
    const work = path.join(store.dataDir, "tmp", `back-${hubId}-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(work, { recursive: true });
    const src = path.join(work, "release.tar.gz");
    await fetchRelease(m, src);
    const tree = path.join(work, "tree");
    fs.mkdirSync(tree);
    await run("tar", ["-xzf", src, "-C", tree, "--no-same-owner"], { log: () => {} });
    const root = findRoot(tree);
    if (!root) throw new Error(`the release of ${m.name} is not a custom-integration archive (no driver.json)`);
    // the integration's current settings go in its config/ and data/ folders
    copyTree(store.configDir(hubId), path.join(root, "config"));
    if (m.ownDataDir) copyTree(store.dataDirOf(hubId), path.join(root, "data"));
    const out = path.join(work, `${m.driverId}-${m.version}-with-settings.tar.gz`);
    const top = fs.readdirSync(root).filter((n) => ["driver.json", "bin", "config", "data"].includes(n));
    await run("tar", ["-czf", out, "--owner=0", "--group=0", "-C", root, ...top], { log: () => {} });
    const buf = fs.readFileSync(out);
    m.backArchive = out;
    store.put(m);
    return { filename: path.basename(out), size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
  });

  link.handle("move.chunk", async ({ hubId, offset, length }) => {
    const m = meta(hubId);
    if (!m.backArchive || !fs.existsSync(m.backArchive)) throw new Error("no archive prepared");
    const fd = fs.openSync(m.backArchive, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.max(0, Math.min(length || 0, 8 * 1024 * 1024, size - offset));
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      return { b64: buf.toString("base64") };
    } finally {
      fs.closeSync(fd);
    }
  });

  link.handle("move.finishBack", async ({ hubId }) => {
    const m = store.get(hubId);
    if (!m) return { ok: true };
    const work = m.backArchive ? path.dirname(m.backArchive) : null;
    await mgr.remove(hubId);
    if (work) fs.rmSync(work, { recursive: true, force: true });
    return { ok: true };
  });
}

/** owner/repo from a GitHub URL, or null. */
export function githubRepo(url) {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/.exec(String(url || ""));
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The repository's tag for a version: v1.2.3 or 1.2.3 (or the newest tag if none matches exactly). */
async function tagFor(url, version) {
  const { out } = await run("git", ["ls-remote", "--tags", "--refs", url], { log: () => {}, timeoutMs: 60000 });
  const tags = out.split("\n").map((l) => l.split("refs/tags/")[1]?.trim()).filter(Boolean);
  for (const t of [`v${version}`, String(version), `V${version}`]) if (tags.includes(t)) return t;
  const loose = tags.find((t) => t.replace(/^v/i, "") === String(version).replace(/^v/i, ""));
  if (loose) return loose;
  throw new InstallError(`the repository has no release tag for version ${version}`);
}

/** The release asset to install on the remote (a .tar.gz, preferring aarch64 / arm64 builds). */
async function releaseAsset(repo, version, ref) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "pegasis-hub" };
  const tags = [...new Set([ref, `v${version}`, String(version)].filter(Boolean))];
  for (const t of tags) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(t)}`, { headers });
    if (!res.ok) continue;
    const rel = await res.json();
    const assets = (rel.assets || []).filter((a) => /\.(tar\.gz|tgz)$/i.test(a.name));
    const pick = assets.find((a) => /aarch64|arm64/i.test(a.name)) || assets.find((a) => !/x86|amd64/i.test(a.name)) || assets[0];
    if (pick) return { name: pick.name, url: pick.browser_download_url };
    throw new Error(`release ${t} of ${repo} has no .tar.gz archive for the remote`);
  }
  throw new Error(`no GitHub release ${tags.join(" / ")} in ${repo}`);
}

async function download(url, file) {
  const res = await fetch(url, { headers: { "User-Agent": "pegasis-hub" }, redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** The folder holding driver.json (the archive's root, or its single top folder). */
function findRoot(dir) {
  if (fs.existsSync(path.join(dir, "driver.json"))) return dir;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (subs.length === 1 && fs.existsSync(path.join(dir, subs[0].name, "driver.json"))) return path.join(dir, subs[0].name);
  return null;
}

/** Writes [{path, b64}] under root, refusing paths that would leave it. */
function writeTree(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const f of files) {
    const rel = String(f.path || "").replace(/\\/g, "/");
    const dest = path.resolve(root, rel);
    if (!rel || rel.startsWith("/") || !dest.startsWith(path.resolve(root) + path.sep)) throw new Error(`refused file path ${rel}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(String(f.b64 || ""), "base64"));
  }
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
}
