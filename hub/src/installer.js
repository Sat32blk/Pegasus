// Installs Unfolded Circle integration drivers into the hub, unmodified, from:
//   - a git repository (GitHub URL; newest release tag by default, or a branch / tag you name)
//   - a custom-integration archive (the same .tar.gz you would upload to the remote)
//   - a local folder (development)
//
// It works out how to run the driver (Node.js, Python or a native binary), installs its
// dependencies in its own folder (node_modules / venv), and returns the run command.
// The hub's supervisor then starts it with UC_INTEGRATION_HTTP_PORT etc. so it listens only
// on 127.0.0.1 inside the container, where the link reaches it.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { run, walk, readJson, cleanId, latestTag, elfArch, hostArch } from "./util.js";

export class InstallError extends Error {}

export class Installer {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.tmpRoot = path.join(dataDir, "tmp");
  }

  #tmp() {
    const d = path.join(this.tmpRoot, crypto.randomBytes(6).toString("hex"));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /** Fetches a git repo into a temp folder. Returns { dir, source }. */
  async fetchGit(url, ref, log) {
    url = String(url || "").trim();
    if (!/^(https?:\/\/|git@)[^\s]+$/.test(url)) throw new InstallError("Enter a git URL such as https://github.com/owner/repo");
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url) && !url.endsWith(".git")) url = url.replace(/\/$/, "") + ".git";
    let useRef = String(ref || "").trim();
    if (!useRef) {
      useRef = (await latestTag(url, log)) || "";
      log(useRef ? `newest release tag: ${useRef}` : "no release tags, using the default branch");
    }
    const tmp = this.#tmp();
    const dir = path.join(tmp, "src");
    const args = ["clone", "--depth", "1", "--recurse-submodules", "--shallow-submodules"];
    if (useRef) args.push("--branch", useRef);
    args.push(url, dir);
    await run("git", args, { log, env: { GIT_TERMINAL_PROMPT: "0" } });
    const { out } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, log: () => {} });
    return { dir, tmp, source: { type: "git", url, ref: useRef || null, followLatest: !ref, commit: out.trim() } };
  }

  /** Extracts an uploaded archive (.tar.gz / .tgz) into a temp folder. */
  async fetchArchive(buf, filename, log) {
    if (!buf?.length) throw new InstallError("The uploaded file is empty");
    const tmp = this.#tmp();
    const file = path.join(tmp, "upload.tar.gz");
    fs.writeFileSync(file, buf);
    const dir = path.join(tmp, "src");
    fs.mkdirSync(dir);
    await run("tar", ["-xzf", file, "-C", dir, "--no-same-owner"], { log });
    fs.rmSync(file);
    return { dir, tmp, source: { type: "archive", filename: filename || "upload.tar.gz" } };
  }

  async fetchLocal(p, log) {
    if (!p || !fs.existsSync(p)) throw new InstallError(`Folder not found: ${p}`);
    const tmp = this.#tmp();
    const dir = path.join(tmp, "src");
    log(`copying ${p}`);
    fs.cpSync(p, dir, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git|venv|\.venv)$/.test(s) });
    return { dir, tmp, source: { type: "local", path: p } };
  }

  /**
   * Reads driver.json and prepares the runtime inside `dir` (which becomes the app folder).
   * Returns { id, driver, runtime, command, cwd } with command paths relative to the app folder.
   */
  async prepare(dir, log, { venvPath } = {}) {
    const files = walk(dir, 4);
    const driverJsonPath = pickDriverJson(dir, files);
    if (!driverJsonPath) throw new InstallError("No driver.json found: this does not look like an Unfolded Circle integration");
    const driver = readJson(driverJsonPath);
    if (!driver?.driver_id) throw new InstallError("driver.json has no driver_id");
    const id = cleanId(driver.driver_id);
    log(`driver: ${driver.driver_id} ${driver.version || ""} (${nameOf(driver)})`);

    // 1. Custom-integration archive layout: driver.json + bin/
    const bin = path.join(path.dirname(driverJsonPath), "bin");
    if (fs.existsSync(bin) && fs.statSync(bin).isDirectory()) {
      const r = await this.#prepareBin(dir, bin, log);
      if (r) return { id, driver, ...r };
    }

    // 2. Node.js source
    const pkgPath = pickNearest(dir, files, "package.json", driverJsonPath);
    // 3. Python source
    const pyMarker = pickNearest(dir, files, "requirements.txt", driverJsonPath) || pickNearest(dir, files, "pyproject.toml", driverJsonPath);

    if (pkgPath && (!pyMarker || depth(dir, pkgPath) <= depth(dir, pyMarker))) {
      return { id, driver, ...(await this.#prepareNode(dir, path.dirname(pkgPath), log)) };
    }
    if (pyMarker) {
      return { id, driver, ...(await this.#preparePython(dir, path.dirname(pyMarker), files, log, venvPath, path.dirname(driverJsonPath))) };
    }
    throw new InstallError("Could not tell how to run this integration (no package.json, requirements.txt, pyproject.toml or bin/ folder)");
  }

  async #prepareBin(root, bin, log) {
    const entries = fs.readdirSync(bin);
    if (entries.includes("driver.js")) {
      if (fs.existsSync(path.join(bin, "package.json")) && !fs.existsSync(path.join(bin, "node_modules"))) {
        await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: bin, log });
      }
      log("runtime: Node.js (custom-integration archive)");
      return { runtime: "node", command: ["node", "driver.js"], cwd: rel(root, bin) };
    }
    // A native executable (often a PyInstaller build for the remote's aarch64 CPU)
    for (const name of ["driver", ...entries]) {
      const f = path.join(bin, name);
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
      const arch = elfArch(f);
      if (!arch) continue;
      if (arch !== hostArch()) {
        throw new InstallError(
          `This archive contains a compiled ${arch} program, but this hub runs on ${hostArch()}. ` +
            `Install the integration from its source repository instead (paste its GitHub URL).`
        );
      }
      fs.chmodSync(f, 0o755);
      log(`runtime: native ${arch} executable bin/${name}`);
      return { runtime: "binary", command: [`./${name}`], cwd: rel(root, bin) };
    }
    return null;
  }

  async #prepareNode(root, pkgDir, log) {
    const pkg = readJson(path.join(pkgDir, "package.json"), {});
    const hasLock = fs.existsSync(path.join(pkgDir, "package-lock.json"));
    const needsBuild = !!pkg.scripts?.build && (fs.existsSync(path.join(pkgDir, "tsconfig.json")) || /tsc|esbuild|rollup|webpack/.test(pkg.scripts.build));
    const npmArgs = [hasLock ? "ci" : "install", "--no-audit", "--no-fund"];
    if (!needsBuild) npmArgs.push("--omit=dev");
    await run("npm", npmArgs, { cwd: pkgDir, log });
    if (needsBuild) await run("npm", ["run", "build"], { cwd: pkgDir, log });

    const candidates = [pkg.main, "dist/driver.js", "build/driver.js", "src/driver.js", "driver.js", "dist/index.js", "index.js", "src/index.js"].filter(Boolean);
    const startScript = pkg.scripts?.start;
    const entry = candidates.find((c) => fs.existsSync(path.join(pkgDir, c)));
    if (!entry && !startScript) throw new InstallError("Node.js project without an entry file (main / driver.js) or a start script");
    log(`runtime: Node.js (${entry ? entry : "npm start"})`);
    return { runtime: "node", command: entry ? ["node", entry] : ["npm", "start", "--silent"], cwd: rel(root, pkgDir) };
  }

  async #preparePython(root, projDir, files, log, venvPath, jsonDir) {
    const venv = venvPath || path.join(root, ".venv");
    await run("python3", ["-m", "venv", venv], { log });
    const pip = path.join(venv, "bin", "pip");
    const py = path.join(venv, "bin", "python");
    await run(pip, ["install", "--no-cache-dir", "--disable-pip-version-check", "-q", "--upgrade", "pip", "wheel"], { log, allowFail: true });
    if (fs.existsSync(path.join(projDir, "requirements.txt"))) {
      await run(pip, ["install", "--no-cache-dir", "--disable-pip-version-check", "-r", "requirements.txt"], { cwd: projDir, log });
    } else {
      await run(pip, ["install", "--no-cache-dir", "--disable-pip-version-check", "."], { cwd: projDir, log });
    }

    // Find the entry point, most reliable first:
    //  1. the integration's own Dockerfile command (how its author runs it)
    //  2. a package that runs as a whole (has __main__.py)
    //  3. a driver.py that runs when started (has an `if __name__ == "__main__"` block)
    //  4. any driver.py (prefer intg-*/, src/, uc_intg_*/ folders)
    // Drivers usually open "driver.json" relative to the working folder and are started from the
    // folder that holds it (e.g. `python src/driver.py` from the repo root), so run from there.
    const cwd = jsonDir && jsonDir.startsWith(projDir) ? jsonDir : projDir;
    const inProj = (f) => f.startsWith(projDir) && !/[\\/](tests?|docs?|examples?)[\\/]/.test(rel(projDir, f));
    const asModule = (pkgDir, sub) => ({ command: [py, "-m", sub ? `${path.basename(pkgDir)}.${sub}` : path.basename(pkgDir)], pythonPath: [rel(root, path.dirname(pkgDir))] });
    const runsItself = (f) => /if\s+__name__\s*==\s*["']__main__["']/.test(fs.readFileSync(f, "utf8"));
    let pick = null;
    let why = "";

    const dockerfile = path.join(projDir, "Dockerfile");
    if (fs.existsSync(dockerfile)) {
      const cmd = dockerCommand(fs.readFileSync(dockerfile, "utf8"));
      const i = cmd ? cmd.findIndex((a) => /^python[0-9.]*$/.test(path.basename(a))) : -1;
      if (i >= 0) {
        const rest = cmd.slice(i + 1).filter((a) => !/^-[uBOI]+$/.test(a));
        if (rest[0] === "-m" && rest[1]) {
          const parts = rest[1].split(".");
          const pkgDir = files.map((f) => path.dirname(f)).find((d) => path.basename(d) === parts[0] && inProj(path.join(d, "x")) && fs.existsSync(path.join(d, "__init__.py")));
          if (pkgDir) {
            pick = { command: [py, "-m", rest[1], ...rest.slice(2)], pythonPath: [rel(root, path.dirname(pkgDir))] };
            why = "its Dockerfile";
          }
        } else if (rest[0] && /\.py$/.test(rest[0])) {
          const f = path.resolve(projDir, rest[0]);
          if (fs.existsSync(f)) {
            // in Docker the project folder is the working folder, so its own packages import
            pick = { command: [py, rel(cwd, f), ...rest.slice(1)], pythonPath: [rel(root, projDir)] };
            why = "its Dockerfile";
          }
        }
      }
    }
    if (!pick) {
      const mains = files.filter((f) => path.basename(f) === "__main__.py" && inProj(f)).sort((a, b) => depth(projDir, a) - depth(projDir, b));
      const withDriver = mains.find((f) => fs.existsSync(path.join(path.dirname(f), "driver.py"))) || mains[0];
      if (withDriver && fs.existsSync(path.join(path.dirname(withDriver), "__init__.py"))) {
        pick = asModule(path.dirname(withDriver));
        why = "its package entry point";
      }
    }
    if (!pick) {
      const drivers = files.filter((f) => path.basename(f) === "driver.py" && inProj(f));
      const score = (f) => (runsItself(f) ? 0 : 1000) + (/[\\/](intg[-_][^\\/]*|src|uc_intg[^\\/]*)[\\/]driver\.py$/.test(f) ? 0 : 100) + depth(projDir, f);
      drivers.sort((a, b) => score(a) - score(b));
      const d = drivers[0];
      if (d) {
        const pkgDir = path.dirname(d);
        pick = fs.existsSync(path.join(pkgDir, "__init__.py")) && !/[\\/]src$/.test(pkgDir) ? asModule(pkgDir, "driver") : { command: [py, rel(cwd, d)], pythonPath: [rel(root, projDir)] };
        why = runsItself(d) ? "its driver.py" : "its driver.py (it may need a start command in Settings)";
      }
    }
    if (!pick) throw new InstallError("Python project without driver.py or __main__.py; set its start command in Settings");
    const { command, pythonPath } = pick;
    log(`entry point from ${why}`);
    log(`runtime: Python (${command.slice(1).join(" ")} in ${rel(root, cwd) || "."})`);
    return { runtime: "python", command: command.map((c) => (c === py ? "$VENV/bin/python" : c)), cwd: rel(root, cwd), pythonPath };
  }

  /** Newest tag for a git source, for update checks. */
  latest(source, log) {
    return source?.type === "git" ? latestTag(source.url, log) : Promise.resolve(null);
  }
}

/** The command of a Dockerfile's last CMD (or ENTRYPOINT + CMD), as an argument list, or null. */
export function dockerCommand(text) {
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const last = (kw) => lines.filter((l) => new RegExp(`^\\s*${kw}\\s`, "i").test(l)).map((l) => l.replace(new RegExp(`^\\s*${kw}\\s+`, "i"), "").trim()).at(-1);
  const parse = (v) => {
    if (!v) return [];
    if (v.startsWith("[")) {
      try {
        return JSON.parse(v).map(String);
      } catch {
        return [];
      }
    }
    return v.split(/\s+/);
  };
  const cmd = [...parse(last("ENTRYPOINT")), ...parse(last("CMD"))].filter((a) => !/^(\/usr\/bin\/)?(tini|dumb-init|--)$/.test(a));
  return cmd.length ? cmd : null;
}

function nameOf(driver) {
  const n = driver.name;
  return typeof n === "string" ? n : n?.en || Object.values(n || {})[0] || driver.driver_id;
}
export { nameOf };

const rel = (root, p) => path.relative(root, p).split(path.sep).join("/");
const depth = (root, p) => rel(root, p).split("/").length;

function pickDriverJson(root, files) {
  const all = files.filter((f) => path.basename(f) === "driver.json");
  all.sort((a, b) => depth(root, a) - depth(root, b));
  return all.find((f) => readJson(f)?.driver_id) || null;
}

/** The file named `name` closest to the root, preferring ones at or above the driver.json folder. */
function pickNearest(root, files, name, near) {
  const all = files.filter((f) => path.basename(f) === name);
  if (!all.length) return null;
  const nearDir = path.dirname(near);
  all.sort((a, b) => {
    const ia = nearDir.startsWith(path.dirname(a)) ? 0 : 1;
    const ib = nearDir.startsWith(path.dirname(b)) ? 0 : 1;
    return ia - ib || depth(root, a) - depth(root, b);
  });
  return all[0];
}
