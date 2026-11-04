import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Atomic JSON write (temp file + rename) so a crash never leaves half a file. */
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Hosted integration id: lowercase [a-z0-9_-], max 32 chars (so the pgs_<id> fallback fits the remote's 36). */
export function cleanId(s) {
  const id = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return id || null;
}

/**
 * Runs a command, streaming each output line to log(). Resolves with the exit code; rejects with
 * an Error on a non-zero exit unless opts.allowFail.
 */
export function run(cmd, args, { cwd, env, log = () => {}, allowFail = false, timeoutMs = 15 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 200000) out = out.slice(-100000);
      for (const line of s.split(/\r?\n/)) if (line.trim()) log(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFail) reject(Object.assign(new Error(`${cmd} exited with ${code}`), { code, out }));
      else resolve({ code, out });
    });
  });
}

/** True when something accepts TCP connections on host:port. */
export function portOpen(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Lists files under dir (max depth), skipping heavy / irrelevant folders. */
export function walk(dir, maxDepth = 4, skip = new Set(["node_modules", ".git", "venv", ".venv", "__pycache__", "test", "tests", "docs"])) {
  const out = [];
  const rec = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !skip.has(e.name) && !e.name.startsWith(".")) rec(p, depth + 1);
      } else out.push(p);
    }
  };
  rec(dir, 0);
  return out;
}

/** Simple semver-ish comparison of tags like v1.2.3 / 1.2.3-beta. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v\.?/i, "").split(/[.-]/);
  const pb = String(b).replace(/^v\.?/i, "").split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!isNaN(nx) && !isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      if (x === "") return 1; // 1.2.3 > 1.2.3-beta
      if (y === "") return -1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Newest release-looking tag of a git remote, or null. */
export async function latestTag(url, log) {
  try {
    const { out } = await run("git", ["ls-remote", "--tags", "--refs", url], { log: () => {}, timeoutMs: 30000 });
    const tags = out
      .split("\n")
      .map((l) => l.split("refs/tags/")[1])
      .filter((t) => t && /^v?\.?\d+(\.\d+)+$/i.test(t.trim()))
      .map((t) => t.trim());
    tags.sort(compareVersions);
    return tags.at(-1) || null;
  } catch (e) {
    log?.(`could not list tags: ${e.message}`);
    return null;
  }
}

/** CPU architecture of an ELF executable ("aarch64", "x86_64", ...) or null if not ELF. */
export function elfArch(file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(20);
    fs.readSync(fd, b, 0, 20, 0);
    fs.closeSync(fd);
    if (b.readUInt32BE(0) !== 0x7f454c46) return null;
    const m = b[5] === 1 ? b.readUInt16LE(18) : b.readUInt16BE(18);
    return { 0xb7: "aarch64", 0x3e: "x86_64", 0x28: "arm", 0x03: "x86" }[m] || `machine-${m}`;
  } catch {
    return null;
  }
}

export function hostArch() {
  return { arm64: "aarch64", x64: "x86_64", arm: "arm", ia32: "x86" }[process.arch] || process.arch;
}
