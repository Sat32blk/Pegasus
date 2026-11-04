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

Current versions: **Hub 0.7.2**, **Bridge 0.4.0**. Tested on a Remote 3 (firmware 2.x) with Govee, LG webOS, Samsung TV, Lyrion Music Server and Plex running on the hub, including moves to the hub and back; Unfolded Circle's Android TV and Apple TV integrations also install and run from GitHub.

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

```yaml
services:
  pegasus-hub:
    image: ghcr.io/sat32blk/pegasus-hub:latest
    container_name: pegasus-hub
    network_mode: host        # integrations find devices with mDNS / SSDP
    restart: unless-stopped
    environment:
      - PEGASIS_PORT=9600     # page and link
      - PUID=1000             # integrations run as this user, not root
      - PGID=100
      - TZ=America/New_York
      # - PEGASIS_PASSWORD=change-me   # optional login for the page
    volumes:
      - ./data:/data
```

Open `http://<server>:9600`.

On **OpenMediaVault** (Compose plugin): Services → Compose → Files → Add, paste the file, point the data folder (left side of `volumes`) at a share, save, **Up**. To update later: **Pull**, then **Up**.

### 2. Install the Bridge on the remote

1. Get `uc-intg-pegasus-bridge-<version>.tar.gz` from the releases (or build it: `cd bridge && sh build.sh`).
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
   - It uses the integration's **real driver ID** (e.g. `plex_driver`), so entity IDs (`plex_driver.main.…`), Home Assistant and the Integration Manager see exactly what they would for a copy installed on the remote.
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

- **Port 9600** is the page and the link. Each integration also uses a port from 10100 up, only inside the container.
- **The data folder** holds the integrations, their settings and logs, the pairing code, battery history and the artwork cache (up to 300 MB). Back it up; nothing else is needed.
- **Building on the server** instead of pulling: replace `image:` with `build: <path to the hub folder>` and run `docker compose up -d --build`.
- `PEGASIS_NAME` sets the name shown to remotes; `PEGASIS_PASSWORD` adds a login to the page (remotes use the pairing code; artwork links don't need the password).

How the hub runs each kind of integration:

| Source | How it runs |
|---|---|
| Python repo | Its own venv. Started the way its author runs it: the Dockerfile's `CMD` first, then a package `__main__.py`, then `driver.py`, from the folder that holds `driver.json` |
| Node.js repo (`package.json`) | `npm ci`, plus `npm run build` for TypeScript |
| Custom-integration archive with `bin/driver.js` | `node driver.js` |
| Archive with a compiled `bin/driver` | Only if it matches the server's CPU (most are aarch64 builds for the remote); otherwise install from its GitHub repo |

Each integration's settings live in `data/integrations/<id>/config` and survive updates.

The Bridge adds three entities on the remote: **Pegasus Hub link** (status), **Pegasus Hub latency** (ms) and **Pegasus: re-sync integrations** (button).

## Develop and test

```sh
npm install && (cd hub && npm install) && (cd bridge/src/bin && npm install)
npm test
npm run sync-proto   # after editing shared/linkproto.js
```

`npm test` runs: the link codec, log masking, battery figures, network statistics, resource history, event shaping, artwork, the Bridge's ID rules, **moves** against `test/mock-remote.js` (a stand-in for the remote's core that behaves like the real one: summary driver list, entity selection by the integration's own IDs, references stripped on driver deletion, no entity listing while an integration is inactive), and an **end-to-end** test (mock core ⇄ Bridge ⇄ hub ⇄ real Node and Python integrations, including standby and artwork).

Run the hub without Docker: `cd hub && PEGASIS_DATA=./data node src/server.js`. Pushes to `main` run the tests and publish amd64 + arm64 images (see PUBLISHING.md).

## Limits and plans

- Built-in integrations stay on the remote (they don't use slots and the firmware owns them).
- Moving back needs a GitHub release with a `.tar.gz` for the remote.
- Ideas: keep integrations connected through short link drops, compress large messages, time a full button press end to end, pick integrations from the Unfolded Circle list, find the hub automatically in the Bridge setup, a Home Assistant add-on.

MIT licence.
