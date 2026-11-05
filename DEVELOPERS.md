# For integration developers: running on Pegasus Hub

Pegasus Hub runs Unfolded Circle integrations on a server (a NAS, a mini PC, a Raspberry Pi) instead of the remote, and links them to the remote through the Pegasus Bridge. Your integration runs unchanged: same `driver.json`, same Integration API, same `UC_CONFIG_HOME`. But it is no longer limited the way it is on the remote:

| | On the remote | On Pegasus Hub |
|---|---|---|
| Battery | every CPU cycle and Wi-Fi packet costs battery | mains powered |
| Memory | shared with the remote's UI and other integrations | the server's memory (usually gigabytes free) |
| Processor | quad-core ARM, shared | the server's cores |
| Remote asleep | Wi-Fi off; integrations are expected to go quiet | keeps running; its events are held and delivered when the remote wakes |
| Install slots | one of 10 | none used |

So you can poll more often, keep connections open, cache more, or do heavier work (image processing, local speech, larger libraries) **when you know you're on the hub**.

## How to tell

The hub starts your integration with these environment variables:

| Variable | Example | Meaning |
|---|---|---|
| `PEGASUS_HUB` | `1` | You're running on Pegasus Hub |
| `PEGASUS_HUB_VERSION` | `0.10.0` | Hub version |
| `PEGASUS_LIMITS` | `relaxed` | Battery, memory and CPU limits of the remote don't apply |
| `PEGASUS_CPU_CORES` | `4` | Processor cores on the server |
| `PEGASUS_MEM_MB` | `15872` | Memory on the server |
| `PEGASUS_REMOTE_ADDRESS` | `192.0.2.93` | The linked remote's address, when one is linked at start. Use it instead of `127.0.0.1` to reach the remote's own API (on the hub, `127.0.0.1` is the server) |
| `PEGASUS_HUB_INFO` | `/data/hubinfo.json` | A JSON file the hub keeps up to date (below) |
| `PEGASUS_HUB_API` | `http://127.0.0.1:9600/api/hubinfo` | The same JSON, live (GET; answered without the page password when asked from the server itself) |

The JSON:

```json
{
  "format": 1,
  "runtime": "pegasus-hub",
  "version": "0.10.0",
  "host": { "arch": "x64", "cores": 4, "memTotalMB": 15872, "memAvailableMB": 11240 },
  "limits": { "relaxed": true, "battery": false, "alwaysOn": true, "memoryMB": 11240, "installSlots": false, "artworkResized": true },
  "remotes": [ { "name": "Remote3-xxxx", "address": "192.0.2.93", "asleep": false, "battery": { "level": 81, "charging": false } } ]
}
```

`remotes[].asleep` tells you whether to bother pushing updates now (the hub holds them while the remote sleeps anyway).

## Examples

Python:

```python
import os, json, urllib.request

ON_HUB = os.environ.get("PEGASUS_HUB") == "1"
POLL_SECONDS = 2 if ON_HUB else 30          # no battery to save on the hub
REMOTE = os.environ.get("PEGASUS_REMOTE_ADDRESS", "127.0.0.1")

def hub_info():
    url = os.environ.get("PEGASUS_HUB_API")
    if not url:
        return None
    with urllib.request.urlopen(url, timeout=2) as r:
        return json.load(r)
```

Node.js:

```js
const onHub = process.env.PEGASUS_HUB === "1";
const pollMs = onHub ? 2000 : 30000;
const remote = process.env.PEGASUS_REMOTE_ADDRESS || "127.0.0.1";
const info = onHub ? await fetch(process.env.PEGASUS_HUB_API).then((r) => r.json()) : null;
```

## Good to know

- **Settings** live in `UC_CONFIG_HOME` as on the remote; when an integration moves between the remote and the hub its files move with it. Saved `127.0.0.1` / `localhost` addresses under keys like `address`, `host` or `ip` are switched to the remote's address on the way to the hub, and back on the way home.
- **Starting:** the hub runs your source the way your release build does (the `pyinstaller` entry in your GitHub workflow), else your Dockerfile's `CMD`, `__main__.py` or `driver.py`. Python libraries are installed as they were on your release date. A separate web UI (e.g. `ui/` built by `npm run build`) is built too. If your integration serves a web page on its own port, the hub page shows an **Open its page** button for it.
- **A container check** by `UC_CONFIG_HOME` starting with `/config` works: integrations that do this get their settings folder under `/config/<id>`.
- **Releases:** moving to the hub installs your GitHub release tag for the installed version; moving back needs a `.tar.gz` in that release. Keep tags as `v1.2.3` (or `1.2.3`).
- **Compatibility list:** [COMPATIBILITY.md](COMPATIBILITY.md).
