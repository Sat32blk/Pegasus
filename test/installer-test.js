// How the hub works out to start an integration, for repository layouts found in the Unfolded
// Circle integration catalog (each case is modelled on real integrations that failed before).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Installer, InstallError, dockerByConfigPath, removedStdlib } from "../hub/src/installer.js";
import { pyinstallerEntry } from "../hub/src/buildentry.js";
import { publicAddress } from "../hub/src/linkserver.js";
import { compareVersions } from "../hub/src/util.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pg-inst-"));
const inst = new Installer({ dataDir: path.join(work, "hub") });
const log = () => {};
let n = 0;
function repo(files) {
  const dir = path.join(work, `r${n++}`);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const DJ = (id) => JSON.stringify({ driver_id: id, version: "1.0.0", name: { en: id } });
const step = (s) => console.log("▶ " + s);

try {
  step("the release build's PyInstaller entry wins over a Dockerfile for another mode (Onkyo)");
  {
    const dir = repo({
      "driver.json": DJ("onkyo"),
      "requirements.txt": "",
      Dockerfile: 'FROM python:3.11\nCMD ["python", "intg-onkyo/container.py"]\n',
      ".github/workflows/build.yml": "env:\n  INTG_NAME: onkyo\njobs:\n  b:\n    steps:\n      - run: |\n          docker run --rm img \\\n            bash -c \"pip install pyinstaller && pyinstaller --clean --onedir --name driver -y intg-${INTG_NAME}/driver.py\"\n",
      "intg-onkyo/driver.py": "import avr\nif __name__ == '__main__':\n    pass\n",
      "intg-onkyo/avr.py": "",
      "intg-onkyo/container.py": "raise SystemExit('container mode')\n"
    });
    assert.equal(pyinstallerEntry(dir), "intg-onkyo/driver.py");
    const p = await inst.prepare(dir, log);
    assert.deepEqual(p.command, ["$VENV/bin/python", "intg-onkyo/driver.py"]);
    console.log("  " + p.command.join(" "));
  }

  step("a folder with a dash and plain sibling imports runs as a script, not python -m (BluOS)");
  {
    const dir = repo({
      "driver.json": DJ("bluos"),
      "requirements.txt": "",
      "intg-bluos/__init__.py": "",
      "intg-bluos/driver.py": "import setup_flow\nif __name__ == '__main__':\n    pass\n",
      "intg-bluos/setup_flow.py": ""
    });
    const p = await inst.prepare(dir, log);
    assert.deepEqual(p.command, ["$VENV/bin/python", "intg-bluos/driver.py"]);
    assert.ok(p.pythonPath.includes("intg-bluos"), "its own folder must be importable");
    console.log("  " + p.command.join(" "));
  }

  step("a package whose __init__.py is the entry (no __main__.py) runs through runpy (NZB info)");
  {
    const dir = repo({
      "driver.json": DJ("nzb"),
      "requirements.txt": "",
      ".github/workflows/build.yml": "      - run: pyinstaller --onedir --name driver uc_intg_nzb/__init__.py\n",
      "uc_intg_nzb/__init__.py": "from .driver import x\nasync def main():\n    pass\nif __name__ == '__main__':\n    pass\n",
      "uc_intg_nzb/driver.py": "x = 1\n"
    });
    const p = await inst.prepare(dir, log);
    assert.equal(p.command[1], "-c");
    assert.match(p.command[2], /runpy\.run_module\("uc_intg_nzb\.__init__", run_name="__main__"/);
    console.log("  " + p.command.slice(1).join(" "));
  }

  step("a driver that opens \"folder/driver.json\" starts in the folder above it (Hubitat)");
  {
    const dir = repo({
      "requirements.txt": "",
      "intg-hub/driver.json": DJ("hubitat"),
      "intg-hub/driver.py": "path = 'intg-hub/driver.json'\nif __name__ == '__main__':\n    pass\n"
    });
    const p = await inst.prepare(dir, log);
    assert.equal(p.cwd, "");
    assert.deepEqual(p.command, ["$VENV/bin/python", "intg-hub/driver.py"]);
    console.log(`  ${p.command.join(" ")} in ${p.cwd || "."}`);
  }

  step("a TypeScript build that puts the driver in dist/src is found (Dreambox, Matter)");
  {
    const dir = repo({
      "driver.json": DJ("dreambox"),
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", main: "dist/driver.js", scripts: { build: "node mk.js" } }),
      "tsconfig.json": "{}",
      "mk.js": "const fs=require('fs');fs.mkdirSync('dist/src',{recursive:true});fs.writeFileSync('dist/src/driver.js','');fs.mkdirSync('dist/test',{recursive:true});fs.writeFileSync('dist/test/driver.js','');"
    });
    const p = await inst.prepare(dir, log);
    assert.deepEqual(p.command, ["node", "dist/src/driver.js"]);
    console.log("  " + p.command.join(" "));
  }

  step(".NET (and Go, Rust) say what they need instead of a vague error");
  {
    const dir = repo({ "src/App/driver.json": DJ("adbtv"), "src/App/App.csproj": "<Project/>", "global.json": "{}" });
    await assert.rejects(inst.prepare(dir, log), (e) => e instanceof InstallError && /written in \.NET/.test(e.message) && /arm64/.test(e.message));
    console.log("  explained (an arm64 hub uses the release archive)");
  }

  step("PEGASUS_ADDRESS: host or host:port the remote reaches the hub at");
  {
    const keep = { ...process.env };
    delete process.env.PEGASUS_ADDRESS;
    assert.equal(publicAddress(), null);
    process.env.PEGASUS_ADDRESS = "192.0.2.5";
    process.env.PEGASUS_PORT = "9600";
    assert.equal(publicAddress(), "192.0.2.5:9600");
    process.env.PEGASUS_ADDRESS = "http://nas.lan:19600/";
    assert.equal(publicAddress(), "nas.lan:19600");
    process.env = keep;
    console.log("  ok");
  }
  step("integrations that look for Docker by a settings folder under /config are recognised (Integration Manager)");
  {
    const im = repo({ "driver.json": DJ("im"), "m/device.py": 'config_home = os.getenv("UC_CONFIG_HOME", "")\nexternal = not config_home or config_home.startswith("/config")\n' });
    const other = repo({ "driver.json": DJ("o"), "d.py": 'p = os.getenv("UC_CONFIG_HOME", "/config")\n' });
    assert.equal(dockerByConfigPath(im), true);
    assert.equal(dockerByConfigPath(other), false);
    console.log("  ok");
  }

  step("a separate web UI is built into the integration (Integration Manager's React page)");
  {
    const dir = repo({
      "driver.json": DJ("im2"),
      "requirements.txt": "",
      "intg-m/driver.py": "if __name__ == '__main__':\n    pass\n",
      "ui/package.json": JSON.stringify({ name: "ui", version: "1.0.0", scripts: { build: "node build.js" } }),
      "ui/build.js": "const fs=require('fs');fs.mkdirSync('../intg-m/static/app',{recursive:true});fs.writeFileSync('../intg-m/static/app/index.html','<html></html>');"
    });
    await inst.prepare(dir, log);
    assert.ok(fs.existsSync(path.join(dir, "intg-m/static/app/index.html")), "the UI wasn't built");
    console.log("  ui/ built into intg-m/static/app");
  }

  step("the project that goes with driver.json is the integration, not a companion plugin beside it (SteamOS HTPC)");
  {
    const dir = repo({
      "integration/driver.json": DJ("steamos"),
      "integration/requirements.txt": "",
      "integration/src/uc_intg_steamos/__init__.py": "",
      "integration/src/uc_intg_steamos/driver.py": "if __name__ == '__main__':\n    pass\n",
      "plugin/package.json": JSON.stringify({ name: "decky-plugin", main: "dist/index.js" }),
      "plugin/dist/index.js": "window.x = 1;\n"
    });
    const p = await inst.prepare(dir, log);
    assert.equal(p.runtime, "python", "the plugin's package.json was taken for the integration");
    console.log("  " + p.command.join(" "));
  }

  step("a package.json that only holds lint tooling doesn't make a Python integration a Node.js one (HDMI matrix)");
  {
    const dir = repo({
      "driver.json": DJ("matrix"),
      "requirements.txt": "",
      "package.json": JSON.stringify({ name: "tooling", scripts: { "lint:js": "eslint ." } }),
      "driver.py": "if __name__ == '__main__':\n    pass\n"
    });
    const p = await inst.prepare(dir, log);
    assert.equal(p.runtime, "python");
    console.log("  " + p.command.join(" "));
  }

  step("an archive whose bin/driver.js reads driver.json next to itself gets a copy there (FM-Audio DSP)");
  {
    const dir = repo({ "driver.json": DJ("fm"), "bin/driver.js": "require('fs').readFileSync(__dirname + '/driver.json');\n" });
    const p = await inst.prepare(dir, log);
    assert.deepEqual(p.command, ["node", "driver.js"]);
    assert.ok(fs.existsSync(path.join(dir, "bin", "driver.json")));
    console.log("  bin/driver.json copied");
  }

  step("modules dropped from Python 3.13 (telnetlib...) are found, so their drop-in packages get installed (NAD power control)");
  {
    const dir = repo({ "a.py": "import os\nimport telnetlib\nfrom cgi import escape\n", "b.py": "import pipes\n", "pipes.py": "" });
    const gone = removedStdlib([path.join(dir, "a.py"), path.join(dir, "b.py"), path.join(dir, "pipes.py")]);
    assert.deepEqual(gone.map((g) => g.pkg).sort(), ["standard-cgi", "standard-telnetlib"]); // pipes is the repository's own
    console.log("  " + gone.map((g) => `${g.module} -> ${g.pkg}`).join(", "));
  }

  step("release tags written v.0.8.1 sort like v0.8.1 (Onkyo)");
  {
    const tags = ["v.0.7.1", "v.0.8.1", "v0.8.0"].sort(compareVersions);
    assert.deepEqual(tags, ["v.0.7.1", "v0.8.0", "v.0.8.1"]);
    console.log("  " + tags.join(" < "));
  }
  console.log("\nINSTALLER: all passed");
} catch (e) {
  console.error("\nINSTALLER FAILED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
