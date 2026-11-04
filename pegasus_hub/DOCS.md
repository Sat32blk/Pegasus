# Pegasus Hub

Pegasus runs Unfolded Circle integrations off the remote. The hub (this add-on) installs and runs them; **Pegasus Bridge**, a small custom integration on the remote, links the remote to the hub and makes every integration here appear under **Integrations** on the remote, with its own setup, devices and entities.

## Getting started

1. Start the add-on and open **Pegasus** in the sidebar.
2. On the remote, install Pegasus Bridge: in the web configurator, **Integrations → Add new → Install custom**, upload `uc-intg-pegasus-bridge-<version>.tar.gz` (from the Pegasus releases on GitHub).
3. Start the Bridge's setup. In the Pegasus page open **Remotes → Pair a remote** and copy the **hub address** and the **pairing code** into it, then enter the web-configurator **PIN**.
4. Add integrations with **+ Add integration** (a GitHub link or a `.tar.gz`), or move ones that are installed on the remote: each remote's section on the page has **Move to hub**.

Make a backup of the remote in its web configurator before your first move.

## Options

| Option | What it does |
|---|---|
| Hub name | The name your remotes show for this hub. |
| Page password | Optional. Asks for a password when the page is opened directly at `http://<this machine>:9600`. Inside Home Assistant's sidebar you're signed in already. Remotes use the pairing code, not this. |

## Network

The add-on uses the host network: the remotes connect to **port 9600** on this machine, and integrations can find devices with mDNS / SSDP like they would on the remote. Each integration also uses a port from 10100 up, but only on 127.0.0.1. Give this machine and the remote fixed addresses in your router (DHCP reservations).

## Data and backups

Everything lives in the add-on's data folder and is included in Home Assistant backups: installed integrations, their settings and logs, the pairing code, battery and network history. The artwork cache is left out of backups.

## Home Assistant entities

For sensors and switches in Home Assistant (battery saved since moving, link speed, each integration's state with start/stop, updates), install the **Pegasus** integration from HACS and point it at this hub (host `127.0.0.1`, port `9600`).

## More

Full documentation, how moves work, and the speed and battery features: https://github.com/Sat32blk/Pegasus
