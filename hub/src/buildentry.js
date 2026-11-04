// Which script the integration's own release build turns into the program that runs on the
// remote: the last .py file a `pyinstaller` command is given in its GitHub workflows or build
// scripts. That is the most faithful way to start it on the hub, more than a Dockerfile (which
// some integrations keep for a different, container-only mode).

import fs from "node:fs";
import path from "node:path";

const MAX_FILES = 40;

/** Returns the path (relative to the repo root) of the build's entry script, or null. */
export function pyinstallerEntry(root) {
  const files = [];
  const wf = path.join(root, ".github", "workflows");
  if (fs.existsSync(wf)) for (const f of fs.readdirSync(wf)) if (/\.ya?ml$/i.test(f)) files.push(path.join(wf, f));
  for (const f of safeList(root)) if (/\.(sh|spec)$/i.test(f) || /^(Makefile|build[\w.-]*)$/i.test(f)) files.push(path.join(root, f));
  for (const file of files.slice(0, MAX_FILES)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (file.endsWith(".spec")) {
      // Analysis(['intg-x/driver.py'], ...)
      const m = /Analysis\(\s*\[\s*['"]([^'"]+\.py)['"]/.exec(text);
      const hit = m && resolve(root, m[1]);
      if (hit) return hit;
      continue;
    }
    const vars = variables(text);
    const joined = text.replace(/\\\r?\n/g, " ");
    for (const line of joined.split(/\r?\n/)) {
      // every "pyinstaller <args>" in the line, except "pip install pyinstaller"
      for (const m of line.matchAll(/(^|[\s;&|("'])pyinstaller\s+([^;&|]*)/g)) {
        if (/install\s+$/.test(line.slice(0, m.index + m[1].length))) continue;
        const cmd = substitute(m[2], vars).replace(/["']/g, " ");
        const pys = cmd.split(/\s+/).filter((t) => /\.py$/.test(t) && !t.startsWith("-"));
        for (const p of pys.reverse()) {
          const hit = resolve(root, p);
          if (hit) return hit;
        }
      }
    }
  }
  return null;
}

function safeList(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

/** NAME: value and NAME=value assignments (workflow env blocks, shell variables). */
function variables(text) {
  const v = {};
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*[:=]\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm)) if (!(m[1] in v)) v[m[1]] = m[2];
  return v;
}

function substitute(s, vars) {
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\$\{\{\s*env\.([A-Z0-9_]+)\s*\}\}/g, (a, k) => vars[k] ?? a)
      .replace(/\$\{([A-Z0-9_]+)\}/g, (a, k) => vars[k] ?? a)
      .replace(/\$([A-Z][A-Z0-9_]*)/g, (a, k) => vars[k] ?? a);
  }
  return s;
}

function resolve(root, p) {
  const clean = p.replace(/^\.\//, "").replace(/^\/(workspace|app|src\/app)\//, "");
  const f = path.resolve(root, clean);
  return f.startsWith(path.resolve(root) + path.sep) && fs.existsSync(f) ? path.relative(root, f).split(path.sep).join("/") : null;
}
