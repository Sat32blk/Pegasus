# Project Pegasus

Run Unfolded Circle integrations in a Docker container on your server, and have them show up on the **Remote 3 / Remote Two** as if they were installed on the remote itself. Move integrations you already installed on the remote to the hub, and back, with one click.

Why:
- **Get past the 10-integration limit.** Integrations on the hub don't use the remote's install slots.
- **Faster.** Integrations run on your server's processor instead of the remote's. Media browsing in particular gets quicker.
- **Easier on the battery.** The remote does less work, the hub holds back updates while the remote sleeps, and artwork is sent at the size the screen shows it.

| Part | Runs on | What it does |
|---|---|---|
| **Pegasus Hub** (`hub/`) | Docker on your server (amd64 or arm64) | Installs integrations from GitHub or an archive, runs each one, restarts crashes, keeps their settings across updates. Management page on port 9600. |
| **Pegasus Bridge** (`bridge/`) | The remote (custom integration, `driver_id: pegasus_bridge`) | Keeps one fast link to the hub and makes every hub integration appear under **Integrations** on the remote, with its own setup, devices and entities. Moves integrations between the remote and the hub. |

Current versions: **Hub 0.9.1**, **Bridge 0.4.3**. Tested on a Remote 3 (firmware 2.x) with Govee, LG webOS, Samsung TV, Lyrion Music Server and Plex running on the hub, including moves to the hub and back; Unfolded Circle's Android TV and Apple TV integrations also install and run from GitHub.

## Contents

- [Quick start](#quick-start)
- [Moving integrations](#moving-integrations)
- [The hub page](#the-hub-page)
- [Speed and battery](#speed-and-battery)
- [How it works](#how-it-works)
- [Install details](#install-details)
- [Develop and test](#develop-and-test)
- [Limits and plans](#limits-and-plans)

## Quick start

### 1. Start the hub

Save this as `docker-compose.yml` (or paste it into your Compose tool) and change the data folder (the left side of `volumes`) to a folder of your own:

```yaml
services:
  pegasus-hub:
    image: ghcr.io/sat32blk/pegasus-hub:latest
    container_name: pegasus-hub
    restart: unless-stopped
    # Host networking: integrations find their devices with mDNS / SSDP broadcasts, which don't
    # cross Docker's own networks. Only PEGASUS_PORT is used on the server's network.
    network_mode: host
    environment:
      - PEGASUS_PORT=9600              # the page (http://server:9600); remotes link here too
      - PUID=1000                      # integrations run as this user, not root
      - PGID=100                       # ...and this group
      - TZ=America/New_York            # your time zone, for logs and charts
      # - PEGASUS_PASSWORD=change-me   # optional login for the page (remotes use the pairing code)
      # - PEGASUS_NAME=Pegasus Hub     # name the remotes show for this hub
    volumes:
      - ./data:/data                   # integrations, their settings and logs, pairing code, history
```

Start it with `docker compose up -d` and open `http://<server>:9600`. Update later with `docker compose pull && docker compose up -d`.

| Setting | Default | What it does |
|---|---|---|
| `PEGASUS_PORT` | `9600` | Port for the page and for the remotes' link. Integrations listen on 127.0.0.1 only, from port 10100 up; a port another program already uses is skipped. |
| `PUID` / `PGID` | `1000` / `100` | The user and group integrations run as (they're third-party code, so not root). `PUID=0` runs them as root. The hub gives the data folder to this user. |
| `TZ` | UTC | Time zone for logs and charts. |
| `PEGASUS_PASSWORD` | none | Adds a login to the page. The remotes use the pairing code, and artwork links are signed, so neither needs it. |
| `PEGASUS_NAME` | `Pegasus Hub` | The hub's name as shown to remotes. |
| `PEGASUS_ADDRESS` | found out | The address the remote reaches the hub at (`host` or `host:port`). Only needed with bridge networking when the page shows a wrong address. |
| data folder | — | Everything the hub keeps: back this folder up; nothing else is needed. |

**On OpenMediaVault** (Compose plugin):
1. **Services → Compose → Files → Add**, give it a name, paste the file above.
2. Change `./data` to a folder on one of your shares, e.g. `/srv/dev-disk-by-uuid-…/appdata/pegasus`.
3. **Save**, then **Up**. To update later: **Pull**, then **Up**.

**On other servers** the same compose file works; only the data folder, the user and where you paste it differ:

| Server | Where | Data folder | `PUID` / `PGID` |
|---|---|---|---|
| Synology DSM 7.2+ | Container Manager → **Project → Create**, paste the file | `/volume1/docker/pegasus-hub` | your DSM user (`id` over SSH; often `1026`) / `100` |
| Unraid | Docker → **Add Container**, template [`hub/unraid/pegasus-hub.xml`](hub/unraid/pegasus-hub.xml) (or Compose Manager) | `/mnt/user/appdata/pegasus-hub` | `99` / `100` |
| TrueNAS SCALE 24.10+ | Apps → Discover Apps → ⋮ → **Install via YAML** | a dataset, e.g. `/mnt/tank/apps/pegasus-hub` | `568` / `568` (the apps user), or the dataset's owner |
| QNAP (Container Station 3) | **Applications → Create**, paste the file | `/share/Container/pegasus-hub` | your QTS user / `100` |
| Portainer, Dockge, CasaOS | **Stacks → Add stack**, paste the file | any folder | the folder's owner |
| Raspberry Pi (64-bit OS) | `docker compose up -d` | any folder | `1000` / `1000` |
| Proxmox | in a VM, or an LXC container with Docker (enable *nesting* and *keyctl*) | any folder | the folder's owner |
| Podman | `podman compose up -d`; rootless: set `PUID=0` (root in the container is your own user) | any folder | — |

The container starts as root only to hand the data folder to `PUID`/`PGID`, then runs everything as that user. If you make it start as another user instead (TrueNAS *Custom User*, `user:` in compose), that user needs write access to the data folder; the log says so if it hasn't.

**Networking.** Host networking (`network_mode: host`, in the file above) is best: integrations find devices with mDNS / SSDP and wake them with Wake-on-LAN, which only work on the LAN itself.
- **Can't use host networking** (Docker Desktop on Windows or a Mac, some NAS setups): remove `network_mode: host` and add `ports: ["9600:9600"]`. The link and artwork work, but integrations can't discover devices or wake them, so enter each device's IP address by hand. If the page shows a hub address like `172.x.x.x`, use the server's own address (the one in your browser) or set `PEGASUS_ADDRESS`.
- **Macvlan** (the container gets its own LAN address): discovery works. By Docker's design the server itself can't talk to a macvlan container, so integrations can't reach other apps on the *same* server (a Plex or Lyrion server there) unless you add a macvlan shim on the host or use host networking.
- **arm64 servers** (Raspberry Pi and other 64-bit ARM) can also run integrations whose release is a compiled program for the remote (e.g. .NET ones), because they share its processor. 32-bit ARM isn't supported.

**If the image won't pull** (`denied` or `not found`): the package is private on GitHub. Either make it public (GitHub → Packages → **pegasus-hub** → Package settings → Change visibility → Public), or log the server in once with `docker login ghcr.io` (user name, and a token with `read:packages`).

**Coming from an earlier version?** Only the image line changes: `ghcr.io/sat32blk/pegasis-hub` became `ghcr.io/sat32blk/pegasus-hub`. Keep your data folder and everything carries over. Settings written as `PEGASIS_…` still work; `PEGASUS_…` is the new spelling.

### 2. Install the Bridge on the remote

1. Download `uc-intg-pegasus-bridge-<version>.tar.gz` from the newest **Pegasus Bridge** release on the [Releases page](https://github.com/Sat32blk/Pegasus/releases) (or build it: `cd bridge && sh build.sh`).
2. Web configurator → **Integrations → Add new → Install custom** → upload it.
3. Start its setup. On the hub page open **Remotes → Pair a remote** and use the **Copy** buttons for the **hub address** and the **pairing code**; paste them in, and enter the web-configurator **PIN** (used once to create an API key; not stored).

To update the Bridge later: Install custom again with **Update existing driver** ticked; its settings are kept.

### 3. Add integrations

- **New ones:** on the hub page, **+ Add integration**, paste a GitHub link (the newest release is used; type a tag to pin one) or upload a `.tar.gz`. It appears on the remote under Integrations; open it there and run its setup as usual.
- **Ones already on the remote:** move them. See below.

## Moving integrations

Install integrations the normal way (web configurator or Integration Manager), then move them from the hub page. Each linked remote has a section listing what runs on the hub, what's installed on the remote (with a 10-slot meter), and what's built in. **Make a backup in the web configurator before your first move.**

**Move to hub**
1. The hub installs the **same version** from the integration's GitHub.
2. Everything that uses its entities is saved: activities (entities, on/off sequences, buttons, pages, touch slider, voice), macros, home-screen pages and groups, entity names and icons.
3. A small **stand-in** takes the integration's place for a moment and hands its settings to the hub copy.
4. The slot is freed: the installed copy is removed, the hub copy is registered under the **same ID**, its entities are selected again, and every saved reference is put back and checked.

Its buttons are missing for a few seconds; afterwards everything works as before, with the same IDs. Or tick **Keep its install slot**: the stand-in stays and passes traffic to the hub; nothing is removed.

**Move back to remote:** everything is saved first, the hub packs the integration's GitHub release with its current settings, the Bridge installs it, puts everything back, and the hub removes its copy.

**If a step fails** the move stops, keeps what it saved, and explains in plain words what happened. **Retry** continues from where it stopped.

Good to know:
- **What can move:** custom integrations whose driver has a GitHub home page and a release tag for the installed version. A test build (e.g. `1.3.6-beta`) has no release: install a released version first. Moving back needs the release's `.tar.gz`.
- **What stays:** the Bridge itself. Built-in integrations don't use slots and can't be removed from the firmware, so there's nothing to gain.
- **Integrations that control the remote** (e.g. Remote Self-Control) can move: settings that point at the remote itself (`127.0.0.1`) are switched to the remote's address on the hub, and back on the way home. Reserve the remote's IP in your router.
- **Some devices ask once to allow the new controller.** Samsung TVs show an *Allow* prompt after a move; set *Access Notification* to *First time only* on the TV to stop it coming back.

## The hub page

- **Four tiles**, each opening a page:
  - **Integrations**: what runs on the hub, what's installed on the remote and why it can or can't move, install slots.
  - **CPU & memory**: the hub and each integration (now, 1-hour average and peak, 1/6/24-hour charts), the server, and the **remote's own** load, memory and free storage, with moves marked.
  - **Network**: round trip (now, typical, 95%, best, worst), traffic, reconnects, per-integration requests and how fast each answers, how many updates the hub didn't send, and artwork savings.
  - **Battery**: level, drain while awake and asleep, and the **saving since your first move** (battery per day, days per charge, and how much data it rests on).
- **Integration table** with filters and search; Start/Stop, Logs (filter, problems only, download), Settings (start command, environment, *Stay connected while the remote sleeps*), Update, Remove.
- **Themes:** System, Light, Dark, Midnight, Slate, Paper, High contrast, six accent colours.
- Works on a phone.


**Integrations with a page of their own** (such as Remote Self-Control's Smart Controls builder) get an **Open its page** button once they run on the hub. It opens the page at the hub's address and the integration's own port, since it no longer runs on the remote. The hub finds these pages itself: ports the integration opens to the network that answer a browser with a web page.
## Speed and battery

**The link**
- One persistent WebSocket for every integration; no handshake per driver, and it's already open when the remote wakes.
- Messages pass through as raw bytes with a 5-byte header (type + channel). About **0.2 ms added per request** on a LAN.
- No added round trips: a session's first messages follow its OPEN frame; `TCP_NODELAY` everywhere.
- Standby-aware heartbeat: while the remote sleeps the hub checks in once a minute and is otherwise silent; on wake the Bridge checks the link at once.

**Traffic the remote doesn't need** (per integration, in the hub)
- Updates for devices the remote doesn't use, and exact repeats, are dropped.
- **While the remote sleeps, updates are held**: the newest state of each device is kept and everything arrives in one go on wake. Answers to the remote's own requests are never held.
- **Stay connected while the remote sleeps** (per integration): the integration isn't told the remote went to sleep, so it keeps its connection to the TV and the first press after waking is quick. Its updates are held, so it costs the remote nothing.

**Artwork at screen size**
- Picture links from integrations (now-playing art, browse thumbnails) are rewritten to signed links on the hub. The hub fetches the original, scales it to the screen width (480 px by default), keeps a copy and serves that.
- Same proportions and size on screen; never cropped or enlarged; transparent pictures stay PNG; small ones are sent as they are. A 1000×1500 poster becomes 480×720, typically 5–10× smaller. If anything fails the remote gets the original.
- On/off and largest size (360–960 px) on the Network page.

**The page itself:** the hub keeps one copy of each remote's integration list for every open page, asks the remote at most once a minute (never while it sleeps), and the Bridge answers "unchanged" instead of resending it.

## How it works

```
 Remote                                                          Docker host
 ┌───────────────────────────────────────────────┐              ┌─────────────────────────────────────┐
 │ core ──ws──▶ 127.0.0.1:9700 ┐                 │              │            ┌─▶ 127.0.0.1:10100 Android TV
 │ core ──ws──▶ 127.0.0.1:9701 ┼─ Pegasus Bridge ═══ one link ═══ Pegasus Hub ┼─▶ 127.0.0.1:10101 Apple TV
 │ core ──ws──▶ 127.0.0.1:9702 ┘                 │   ws :9600   │            └─▶ 127.0.0.1:10102 …
 └───────────────────────────────────────────────┘   /link      └─────────────────────────────────────┘
```

1. For each integration on the hub, the Bridge opens a loopback endpoint on the remote and registers it with the remote's core as an **external driver** (`POST /api/intg/drivers`).
   - It uses the integration's **real driver ID** (e.g. `plex_driver`), so entity IDs (`plex_driver.main.…`) and tools such as the Integration Manager see exactly what they would for a copy installed on the remote.
   - If that ID is taken on the remote, it uses `pgs_<id>` instead, and says so.
2. The core talks to that endpoint as it would to any integration, including its setup screens.
3. The Bridge splices each connection onto one channel of the link; the hub splices the channel onto the integration running in the container.

Link protocol: `shared/linkproto.js` (documented at the top of the file), including two-way requests used for moves and status.

**Safety rules**
- An integration is **deleted from the remote only when you remove it on the hub.** One that's stopped, crashed or offline stays registered, because deleting a driver also deletes its entities and their places on your activity pages.
- The Bridge only ever changes or deletes registrations it made itself; IDs are kept for good once registered.
- If the hub is down, the remote's connections get "try again later" and reconnect by themselves.
- Integrations listen only on 127.0.0.1 inside the container and run as PUID/PGID, not root. The link needs the pairing code (compared in constant time). API keys, passwords and tokens are masked in logs. Artwork links are signed, so the hub can't be used as an open image proxy.

## Install details

- **The data folder** holds the integrations, their settings and logs, the pairing code, battery history and the artwork cache (up to 300 MB). Back it up; nothing else is needed.
- **Pinning a version:** every build is also tagged with the hub's version, e.g. `image: ghcr.io/sat32blk/pegasus-hub:0.9.1` instead of `:latest`.
- **Building on the server** instead of pulling: replace `image:` with `build: <path to the hub folder>` and run `docker compose up -d --build`.

How the hub runs each kind of integration:

| Source | How it runs |
|---|---|
| Python repo | Its own venv, with the libraries as they were on the release date (newer ones sometimes break integrations that don't pin them; if that doesn't install, the newest). Started the way its release for the remote is built (the `pyinstaller` entry in its GitHub workflow), else its Dockerfile's `CMD`, a package `__main__.py`, or `driver.py` |
| Node.js repo (`package.json`) | `npm ci`, plus `npm run build` for TypeScript (the output is found wherever the build puts it) |
| .NET, Go, Rust | Not built on the hub. On an arm64 hub its release archive for the remote is used instead |
| Custom-integration archive with `bin/driver.js` | `node driver.js` |
| Archive with a compiled `bin/driver` | Only if it matches the server's CPU (most are aarch64 builds for the remote); otherwise install from its GitHub repo |

Each integration's settings live in `data/integrations/<id>/config` and survive updates.

**Which integrations work:** [COMPATIBILITY.md](COMPATIBILITY.md) has every integration in the Unfolded Circle integration catalog, installed and started on the hub: 110 of 116 work.

The Bridge adds three entities on the remote: **Pegasus Hub link** (status), **Pegasus Hub latency** (ms) and **Pegasus: re-sync integrations** (button).

## Develop and test

```sh
npm install && (cd hub && npm install) && (cd bridge/src/bin && npm install)
npm test
npm run sync-proto   # after editing shared/linkproto.js
```

`npm test` runs: the link codec, log masking, battery figures, network statistics, resource history, event shaping, artwork, the Bridge's ID rules, how integrations from the catalog are started, **moves** against `test/mock-remote.js` (a stand-in for the remote's core that behaves like the real one: summary driver list, entity selection by the integration's own IDs, references stripped on driver deletion, no entity listing while an integration is inactive), and an **end-to-end** test (mock core ⇄ Bridge ⇄ hub ⇄ real Node and Python integrations, including standby and artwork).

Run the hub without Docker: `cd hub && PEGASUS_DATA=./data node src/server.js`. Pushes to `main` run the tests and publish amd64 + arm64 images (see PUBLISHING.md).

## Limits and plans

- Built-in integrations stay on the remote (they don't use slots and the firmware owns them).
- Moving back needs a GitHub release with a `.tar.gz` for the remote.
- Ideas: keep integrations connected through short link drops, compress large messages, time a full button press end to end, pick integrations from the Unfolded Circle list, find the hub automatically in the Bridge setup.

MIT licence.
