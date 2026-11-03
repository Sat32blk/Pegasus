# Project Pegasis

Run Unfolded Circle integrations in a Docker container, and have them show up on the Remote 3 / Remote Two as if they were installed on the remote itself.

Two parts:

| Part | Runs on | What it does |
|---|---|---|
| **Pegasis Hub** (`hub/`) | Docker (your server) | Installs integrations from GitHub or from a custom-integration archive, runs each one in the container, restarts them if they crash, keeps their settings across updates. Has a management page on port 9600. |
| **Pegasis Bridge** (`bridge/`) | The remote (custom integration, `driver_id: pegasis_bridge`) | Keeps one fast link to the hub and makes every hub integration appear under **Integrations** on the remote, with its own setup, devices and entities. |

## How it works

```
 Remote                                                          Docker host
 ┌───────────────────────────────────────────────┐              ┌─────────────────────────────────────┐
 │ core ──ws──▶ 127.0.0.1:9700 ┐                 │              │            ┌─▶ 127.0.0.1:10100 Android TV
 │ core ──ws──▶ 127.0.0.1:9701 ┼─ Pegasis Bridge ═══ one link ═══ Pegasis Hub ┼─▶ 127.0.0.1:10101 Apple TV
 │ core ──ws──▶ 127.0.0.1:9702 ┘                 │   ws :9600   │            └─▶ 127.0.0.1:10102 …
 └───────────────────────────────────────────────┘   /link      └─────────────────────────────────────┘
```

1. For each integration on the hub, the Bridge opens a loopback endpoint on the remote and registers it with the remote's core as an **external driver** (`POST /api/intg/drivers` with `driver_url: ws://127.0.0.1:<port>`).
   - It uses the integration's **real driver ID** (e.g. `plex_driver`), so the tile, the entity IDs (`plex_driver.main.…`), Home Assistant and the Integration Manager see exactly what they would for a copy installed on the remote.
   - If that ID is already taken on the remote (the same integration installed directly, a built-in one, or someone else's external driver), it uses `pgs_<id>` instead, and says so.
   - It only ever changes or deletes registrations it made itself, and an integration keeps its ID for good once registered (renaming would mean deleting it, which wipes its places on activity pages). Integrations registered by Bridge 0.1.x keep their `pgs_` IDs.
2. The core talks to that endpoint exactly as it would to any integration. It fetches the driver's own name, icon and setup screens from it, so it looks and behaves like the real thing.
3. The Bridge splices each of those WebSocket connections onto one channel of the link. The Hub splices the channel onto the driver running in the container.

### Why it's fast

- **One persistent link** for every integration. There is no TCP or WebSocket handshake per driver, and the link is already open when the remote wakes.
- **Messages pass through as raw bytes.** Neither side parses the Integration API JSON. Each message gets a 5-byte header (type + channel) and nothing else.
- **No added round trips.** A session's first messages are sent right behind its OPEN frame, and the hub queues them until the driver connection is up.
- `TCP_NODELAY` is set on every hop, and compression is off (it costs more time than it saves on a LAN).
- Measured in the end-to-end test: **≈0.25 ms added per request** on top of the network hop.
- Binary frames, such as voice audio, pass through untouched.

Link protocol: `shared/linkproto.js` (documented at the top of the file).

### Safety rules built in

- An integration is **deleted from the remote only when you remove it on the hub.** One that is stopped, crashed or offline stays registered, because deleting a driver also deletes its entities and their places on your activity pages. You can turn this off in the Bridge setup.
- If the hub is down, the remote's connections get "try again later" (1013) and reconnect by themselves when the link is back.
- The Bridge uses the web-configurator PIN once, to create an API key (named "Pegasis Bridge <date>"). The PIN is not stored.
- Hosted drivers listen only on 127.0.0.1 inside the container. The link needs the pairing code, compared in constant time.

## Install

### 1. The hub (Docker)

The image is built for Intel/AMD (amd64) and ARM (arm64, e.g. a Raspberry Pi) and published as `ghcr.io/sat32blk/pegasis-hub` (see PUBLISHING.md).

```yaml
services:
  pegasis-hub:
    image: ghcr.io/sat32blk/pegasis-hub:latest
    container_name: pegasis-hub
    network_mode: host        # integrations discover devices with mDNS / SSDP
    restart: unless-stopped
    environment:
      - PEGASIS_PORT=9600     # page and link
      - PUID=1000             # integrations run as this user, not root (PUID=0 for root)
      - PGID=100
      - TZ=America/New_York
      # - PEGASIS_PASSWORD=change-me   # optional login for the page
    volumes:
      - ./data:/data
```

Then open `http://<server>:9600`.

**On OpenMediaVault** (Compose plugin): Services → Compose → Files → Add, paste the file above, set the data folder (left side of `volumes`) to a folder on a share, save, and press **Up**.

**Before the image is published**, build it on the server instead:
1. Copy the `hub` folder to a share on the server, e.g. `/srv/dev-disk-by-uuid-…/appdata/pegasis/hub`.
2. In the compose file, replace the `image:` line with `build: /srv/dev-disk-by-uuid-…/appdata/pegasis/hub` (the folder from step 1).
3. Press **Up**. The first build takes a few minutes. After changing the hub's files, rebuild with `docker compose up -d --build`.

What runs where:
- **Port 9600** is the page and the link the remotes connect to. Each integration also uses a port from 10100 up, but only inside the container (127.0.0.1).
- **The data folder** holds the installed integrations, their settings and logs, and the pairing code. Back this folder up; nothing else is needed.
- **Integrations run as PUID/PGID**, not root, because they are third-party code. The hub hands the data folder to that user when it starts.

Add integrations by pasting a GitHub URL (the newest release tag is used; type a tag or branch to pin one) or by uploading a `.tar.gz`. Tested from GitHub: Unfolded Circle's **Android TV** (0.10.0) and **Apple TV** (0.25.1).

How the hub runs each kind of integration:

| Source | How it runs |
|---|---|
| Python repo (`requirements.txt` / `pyproject.toml`) | Its own venv; started from the folder that holds `driver.json` |
| Node.js repo (`package.json`) | `npm ci`, plus `npm run build` for TypeScript |
| Custom-integration archive with `bin/driver.js` | `node driver.js` |
| Archive with a compiled `bin/driver` | Only if it matches the server's CPU. Most are aarch64 builds for the remote, so install those from their GitHub repo instead; the hub tells you so. |

Each integration's own settings live in `data/integrations/<id>/config` and survive updates. **Settings** on its card lets you change the start command and add environment variables.

### 2. The bridge (remote)

1. Build: `cd bridge && sh build.sh` gives `dist/uc-intg-pegasis-bridge-0.1.0.tar.gz`. A prebuilt copy is in `dist/`.
2. Web configurator → Integrations → Add new → **Install custom** → upload the archive.
3. Start its setup and enter the **hub address**, the **pairing code** (both shown on the hub's page) and the **web-configurator PIN**.
4. Every hub integration now appears under **Integrations**. Open one and run its setup, exactly as if it were installed on the remote.

The Bridge also adds three entities: **Pegasis Hub link** (status text), **Pegasis Hub latency** (ms) and **Pegasis: re-sync integrations** (a button).

## Develop and test

```sh
npm install && (cd hub && npm install) && (cd bridge/src/bin && npm install)
npm test        # codec test + end-to-end test (mock core ⇄ bridge ⇄ hub ⇄ real Node and Python drivers)
npm run sync-proto   # after editing shared/linkproto.js
```

Run the hub without Docker: `cd hub && PEGASIS_DATA=./data node src/server.js`.

## Not done yet / ideas

- The Docker image has not been built yet: this workspace can't reach any container registry. Everything the image runs was tested here as an unprivileged user (see PUBLISHING.md for building on the server).
- The hub page is a working first version, not a reviewed design. A mockup pass is the next step if you want one.
- Auto-discovering the hub from the Bridge setup (mDNS `_pegasis-hub._tcp`).
- Picking integrations from the Unfolded Circle integrations list instead of pasting URLs.
- Several hubs per remote, and Stowaway-style sleep for integrations that aren't in use.
