# Integration compatibility

Every custom integration in the Unfolded Circle integration catalog (the list the Integration Manager shows), installed the way the hub installs it (newest release from GitHub, Python 3.13 / Node.js 22 on x86_64) and started: it counts as working when it opens its port and answers the remote's first request. Checked 2026-11-04 against hub 0.9.0.

**110 of 116 work.** 100 did before hub 0.9.0.

Setting up a device still needs the device on your network: with host networking the hub finds it like the remote does; with bridge networking enter its IP address.

## Not working, and why

| Integration | Why |
|---|---|
| Kaleidescape | Its v2.0.2 release doesn't start (driver.py imports start_ksd, which ksd_manager.py doesn't have). An upstream bug; keep it on the remote until a fixed release. |
| Lyngdorf | Its source includes a git submodule (pylyngdorf) that GitHub doesn't hand out (probably private), so it can't be built from source. Keep it on the remote. |
| ADB TV Control | .NET, which the hub can't build. On an arm64 hub (Raspberry Pi etc.) the hub uses its release archive instead (not tested yet). |
| Electrolux | .NET (as above). |
| Remote System Monitor | .NET (as above). It also reads the remote's own system status, so it belongs on the remote anyway. |
| Oppo/Magnetar Blu-ray Player | .NET (as above). |

## Fixed in hub 0.9.0

| Integration | What was wrong |
|---|---|
| Anthem A/V Receivers | newer libraries broke it; now installed with the libraries of its release date |
| Panasonic Viera | newer libraries broke it; now installed with the libraries of its release date |
| Ubiquiti UniFi Network & Protect Controls | newer libraries broke it; now installed with the libraries of its release date |
| NZB Info | started the wrong file; now started the way its release build does |
| BluOS Streaming Players | was started as a package; now as a script |
| Hubitat | started in the wrong folder; now where it looks for driver.json |
| Onkyo AVR | its Dockerfile runs a container-only mode; now the release build's driver.py |
| Dreambox | TypeScript output in dist/src wasn't found; now found |
| Matter | TypeScript output in dist/src wasn't found; now found |
| Trinnov Altitude | needs a library shipped in its repository; now installed from there |
| Apple TV Siri Voice | its "npm start" left the driver running after a stop; now started directly, and stopping ends everything it started |

## Integrations that control the remote itself

Remote Self-Control, Advanced Automations, Dashboard, Remote Sync and System Monitor talk to the remote's own API, which on the remote is `127.0.0.1`. When one of them moves, the hub switches saved `127.0.0.1` / `localhost` addresses in its settings to the remote's address. Advanced Automations takes the address from an environment variable instead: on the hub, open its **⋯ → Settings** and add `UC_CORE_URL=ws://<remote address>/ws`.

Some integrations also open a page or service of their own (Advanced Automations on port 9201, Apple TV Siri as a HomeKit accessory). With host networking those ports are on the server, so they must be free there.

## Moving

A move needs the integration's GitHub repository and a release tag for the installed version. The hub finds the repository in its driver.json or, since 0.9.0, in the catalog (FYTA, Lumagen, Trinnov and Steam link a web page instead), and accepts tags written `v.0.8.1` (Onkyo). Moving back also needs a `.tar.gz` in the GitHub release.

## All results

| Integration | Runs as | Started with | Result |
|---|---|---|---|
| [Acmeda Pulse Hub](https://github.com/dgaust/uc-acmeda-pulse) | python | `python driver.py` | works |
| [ADB TV Control](https://github.com/henrikwidlund/unfoldedcircle-adbtv) | — | — | no |
| [Advanced Automations](https://github.com/jstnjx/uc-advanced-automations) | python | `python -m uc_advanced_automations` | works |
| [Amazon eero Network Devices Integration](https://github.com/mase1981/uc-intg-eero) | python | `python -m uc_intg_eero` | works |
| [Anthem A/V Receivers](https://github.com/mase1981/uc-intg-anthemav) | python | `python uc_intg_anthemav/driver.py` | works |
| [Apple TV Keyboard](https://github.com/jstnjx/uc-intg-appletv-keyboard) | python | `python intg-appletv-keyboard/driver.py` | works |
| [Apple TV Siri Voice](https://github.com/albaintor/appletv-siri) | node | `node dist/src/index.js` | works |
| [Arcam FMJ](https://github.com/mase1981/uc-intg-arcam) | python | `python -m intg_arcam` | works |
| [AWOL Valerion](https://github.com/tinogo/uc-intg-awol-valerion) | python | `python -m uc_intg_awol_valerion` | works |
| [BEQ (EZBEQ) Server Support](https://github.com/mase1981/uc-intg-ezbeq) | python | `python -m uc_intg_ezbeq` | works |
| [Bluesound](https://github.com/mase1981/uc-intg-bluesound) | python | `python -m uc_intg_bluesound` | works |
| [BluOS Streaming Players](https://github.com/bjekel/uc-integration-bluos) | python | `python intg-bluos/driver.py` | works |
| [Bond Bridge](https://github.com/mase1981/uc-intg-bond) | python | `python -m uc_intg_bond.driver` | works |
| [Bose Music Supported Devices](https://github.com/mase1981/uc-intg-bose) | python | `python -m uc_intg_bose` | works |
| [Bose Soundtouch Supported Devices](https://github.com/mase1981/uc-intg-soundtouch) | python | `python -m uc_intg_soundtouch` | works |
| [Broadlink](https://github.com/JackJPowell/uc-intg-broadlink) | python | `python intg-broadlink/driver.py` | works |
| [Cambridge Audio](https://github.com/mase1981/uc-intg-cambridge-audio) | python | `python -m uc_intg_cambridge_audio` | works |
| [CCTV](https://github.com/mase1981/uc-intg-cctv) | python | `python -m uc_intg_cctv` | works |
| [Channels DVR](https://github.com/JackJPowell/uc-intg-channels) | python | `python intg-channels/driver.py` | works |
| [Demo Integration](https://github.com/JackJPowell/uc-intg-demo) | python | `python intg-demo/driver.py` | works |
| [Denon HEOS](https://github.com/mase1981/uc-intg-heos) | python | `python -m uc_intg_heos` | works |
| [Dreambox](https://github.com/TheNetStriker/integration-dreambox) | node | `node dist/src/driver.js` | works |
| [Dune-HD](https://github.com/petercv/ucr2-integration-dunehd) | python | `python src/driver.py` | works |
| [Dyson](https://github.com/sbr-labs/dyson-uc) | python | `python driver.py` | works |
| [Ecobee Devices](https://github.com/mase1981/uc-intg-ecobee) | python | `python -m uc_intg_ecobee` | works |
| [Electrolux](https://github.com/henrikwidlund/unfoldedcircle-electrolux) | — | — | no |
| [Emby](https://github.com/mase1981/uc-intg-emby) | python | `python -m uc_intg_emby` | works |
| [Emotiva](https://github.com/mase1981/uc-intg-emotiva) | python | `python -m uc_intg_emotiva.driver` | works |
| [Epson PJLink Projectors](https://github.com/mase1981/uc-intg-epson) | python | `python -m uc_intg_epson` | works |
| [Eversolo](https://github.com/mase1981/uc-intg-eversolo) | python | `python -m uc_intg_eversolo` | works |
| [Fire TV](https://github.com/mase1981/uc-intg-firetv) | python | `python -m intg_firetv` | works |
| [FYTA plant sensors](https://github.com/FYTA-GmbH/uc-integration-fyta) | python | `python driver.py` | works |
| [Govee](https://github.com/mase1981/uc-intg-govee) | python | `python -m uc_intg_govee.driver` | works |
| [HDFury](https://github.com/mase1981/uc-intg-hdfury) | python | `python -m uc_intg_hdfury` | works |
| [Hisense VIDAA Smart TVs](https://github.com/mase1981/uc-intg-vidaa) | python | `python -m uc_intg_vidaa` | works |
| [Horizon](https://github.com/mase1981/uc-intg-horizon) | python | `python -m uc_intg_horizon` | works |
| [HTPC](https://github.com/mase1981/uc-intg-htpc) | python | `python -m uc_intg_htpc` | works |
| [HTTP requests, WoL & text over TCP](https://github.com/kennymc-c/ucr2-integration-requests) | python | `python intg-requests/driver.py` | works |
| [Hubitat](https://github.com/tommy-lapierre/uc-intg-hubitat) | python | `python intg-hubitat/driver.py` | works |
| [Hunter Douglas Powerview](https://github.com/JackJPowell/uc-intg-powerview) | python | `python intg-powerview/driver.py` | works |
| [Integration Manager](https://github.com/JackJPowell/uc-intg-manager) | python | `python intg-manager/driver.py` | works |
| [JBL AV MA Recievers](https://github.com/mase1981/uc-intg-jblav) | python | `python -m intg_jblav` | works |
| [JBL Soundbar Devices](https://github.com/mase1981/uc-intg-jbl-one) | python | `python -m uc_intg_jbl_one` | works |
| [Jellyfin](https://github.com/mase1981/uc-intg-jellyfin) | python | `python -m uc_intg_jellyfin` | works |
| [JVC Projector](https://github.com/JackJPowell/uc-intg-jvc) | python | `python intg-jvc/driver.py` | works |
| [Kaleidescape](https://github.com/johncarey70/uc-integration-kaleidescape) | python | `python intg-kaleidescape/driver.py` | no |
| [KEF Network Speakers](https://github.com/mase1981/uc-intg-kef-speakers) | python | `python -m uc_intg_kef_speakers` | works |
| [KNX Smart Home and Building Solutions](https://github.com/mase1981/uc-intg-knx) | python | `python -m uc_intg_knx` | works |
| [Kodi](https://github.com/albaintor/integration-kodi) | python | `python src/driver.py` | works |
| [LG Soundbar](https://github.com/albaintor/integration-lgsoundbar) | python | `python src/driver.py` | works |
| [LG TV](https://github.com/albaintor/integration-lgtv) | python | `python src/driver.py` | works |
| [Logitech Media Server](https://github.com/mase1981/uc-intg-lmserver) | python | `python -m uc_intg_lmserver` | works |
| [Lumagen Radiance Pro](https://github.com/johncarey70/uc-integration-lumagen) | python | `python intg-lumagen/driver.py` | works |
| [Lutron](https://github.com/JackJPowell/uc-intg-lutron) | python | `python intg-lutron/driver.py` | works |
| [Lyngdorf](https://github.com/jsoutter/uc-intg-lyngdorf) | — | — | no |
| [MadVR](https://github.com/mase1981/uc-intg-madvr) | python | `python -m uc_intg_madvr.driver` | works |
| [Matter](https://github.com/TheNetStriker/integration-matter) | node | `node dist/src/driver.js` | works |
| [Monoprice HTP-1](https://github.com/mase1981/uc-intg-monoprice-htp1) | python | `python -m intg_monoprice_htp1` | works |
| [Motion Blinds Devices](https://github.com/mase1981/uc-intg-motion-blinds) | python | `python -m uc_intg_motion_blinds` | works |
| [MPC-HC](https://github.com/albaintor/integration-mpchc) | python | `python src/driver.py` | works |
| [Music Assistant](https://github.com/JackJPowell/uc-intg-musicassistant) | python | `python intg-musicassistant/driver.py` | works |
| [Music Play](https://github.com/daCream87/uc-deezer-play) | python | `python -m intg_deezer_play` | works |
| [NAD A/V](https://github.com/mase1981/uc-intg-nadav) | python | `python -m intg_nadav` | works |
| [Naim Audio](https://github.com/mase1981/uc-intg-naim) | python | `python -m uc_intg_naim` | works |
| [Nanoleaf Smart Lighting](https://github.com/mase1981/uc-intg-nanoleaf) | python | `python -m uc_intg_nanoleaf.driver` | works |
| [NASA Mission Control](https://github.com/mase1981/uc-intg-nasa) | python | `python -m uc_intg_nasa.driver` | works |
| [NZB Info](https://github.com/mase1981/uc-intg-nzbinfo) | python | `python -c import runpy; runpy.run_module("uc_intg_nzbinfo.__init__"…` | works |
| [OctoPrint](https://github.com/mase1981/uc-intg-octoprint) | python | `python -m intg_octoprint` | works |
| [Onkyo / Integra / Pioneer AVR](https://github.com/EddyMcNut/uc-intg-onkyo-avr) | node | `node dist/driver.js` | works |
| [Onkyo AVR](https://github.com/quintz/onkyo-remotetwo) | python | `python intg-onkyoavr/driver.py` | works |
| [Oppo/Magnetar Blu-ray Player](https://github.com/henrikwidlund/unfoldedcircle-oppo) | — | — | no |
| [Orange TV](https://github.com/albaintor/integration-orangetv) | python | `python src/driver.py` | works |
| [Panasonic Bluray](https://github.com/albaintor/integration_panasonicbluray) | python | `python src/driver.py` | works |
| [Panasonic Viera](https://github.com/mase1981/uc-intg-panasonicviera) | python | `python -m intg_panasonicviera` | works |
| [Philips Hue Sync Box](https://github.com/daCream87/uc-hue-sync-box) | python | `python -m intg_hue_sync_box` | works |
| [Philips Titan OS TV](https://github.com/daCream87/uc-philips-titanos) | python | `python -m intg_philips_titanos` | works |
| [PlayStation Network](https://github.com/JackJPowell/uc-intg-psn) | python | `python intg-psn/driver.py` | works |
| [Plex](https://github.com/JackJPowell/uc-intg-plex) | python | `python intg-plex/driver.py` | works |
| [PS4/PS5 Power Control](https://github.com/stakats/uc-intg-ps5-power) | node | `node dist/src/driver.js` | works |
| [R_volution](https://github.com/mase1981/uc-intg-rvolution) | python | `python -m uc_intg_rvolution` | works |
| [RainBird Devices](https://github.com/mase1981/uc-intg-rainbird) | python | `python -m uc_intg_rainbird` | works |
| [Remote Self-Control](https://github.com/Sat32blk/uc-remote-self-control) | node | `node driver.js` | works |
| [Remote Sync](https://github.com/jstnjx/uc-remote-sync) | node | `node src/driver.js` | works |
| [Remote System Monitor](https://github.com/henrikwidlund/unfoldedcircle-systemmonitor) | — | — | no |
| [Rheem Econet Devices](https://github.com/mase1981/uc-intg-econet) | python | `python -m uc_intg_econet` | works |
| [Russound RIO](https://github.com/ferdaze/uc-intg-russound) | python | `python intg-russound/driver.py` | works |
| [Samsung TV](https://github.com/JackJPowell/uc-intg-samsungtv) | python | `python intg-samsungtv/driver.py` | works |
| [Schlage Devices](https://github.com/mase1981/uc-intg-schlage) | python | `python -m uc_intg_schlage` | works |
| [Shelly Devices](https://github.com/mase1981/uc-intg-shelly) | python | `python -m uc_intg_shelly` | works |
| [Sky Q](https://github.com/mase1981/uc-intg-skyq) | python | `python -m uc_intg_skyq` | works |
| [Sky Stream](https://github.com/mase1981/uc-intg-sky-stream) | python | `python -m uc_intg_sky_stream` | works |
| [SmartThings](https://github.com/mase1981/uc-intg-smartthings) | python | `python -m uc_intg_smartthings` | works |
| [Sony ADCP Projector](https://github.com/kennymc-c/ucr-integration-sonyADCP) | python | `python intg-sonyadcp/driver.py` | works |
| [Sony Audio Control](https://github.com/James-Smart/uc-sony) | python | `python src/driver.py` | works |
| [Sony AVR](https://github.com/albaintor/integration-sonyavr) | python | `python src/driver.py` | works |
| [Sony Bluray](https://github.com/albaintor/integration-sonybluray) | python | `python src/driver.py` | works |
| [Sony SDCP Projector](https://github.com/kennymc-c/ucr2-integration-sonySDCP) | python | `python intg-sonysdcp/driver.py` | works |
| [Spotify](https://github.com/mase1981/uc-intg-spotify) | python | `python -m uc_intg_spotify` | works |
| [Steam](https://github.com/mase1981/uc-intg-steam) | python | `python -m uc_intg_steam.driver` | works |
| [StormAudio](https://github.com/tinogo/uc-intg-stormaudio) | python | `python -m uc_intg_stormaudio` | works |
| [Synology System](https://github.com/mase1981/uc-intg-synology-system) | python | `python -m uc_intg_synology_system.driver` | works |
| [Tapo Smart Devices](https://github.com/AshleyFinney/uc-intg-tapo) | python | `python -m uc_intg_tapo` | works |
| [Trinnov Altitude](https://github.com/johncarey70/uc-integration-trinnov) | python | `python intg-trinnov/driver.py` | works |
| [Ubiquiti UniFi Network & Protect Controls](https://github.com/mase1981/uc-intg-unifi) | python | `python -m intg_unifi` | works |
| [UC Dashboard](https://github.com/jstnjx/uc-dashboard) | node | `node driver.js` | works |
| [VLC](https://github.com/mase1981/uc-intg-vlcmedia) | python | `python -m uc_intg_vlcmedia.driver` | works |
| [Weather](https://github.com/mase1981/uc-intg-weather) | python | `python -m uc_intg_weather` | works |
| [Whisker Litter Robot](https://github.com/mase1981/uc-intg-whisker) | python | `python -m uc_intg_whisker` | works |
| [WiiM](https://github.com/mase1981/uc-intg-wiim) | python | `python -m uc_intg_wiim` | works |
| [Worldwide Sports](https://github.com/mase1981/uc-intg-sports) | python | `python -m uc_intg_sports` | works |
| [Xbox](https://github.com/mase1981/uc-intg-xbox) | python | `python -m uc_intg_xbox` | works |
| [Yamaha AVR](https://github.com/JackJPowell/uc-intg-yamaha-avr) | python | `python intg-yamaha-avr/driver.py` | works |
| [Yamaha MusicCast](https://github.com/mase1981/uc-intg-musiccast) | python | `python -m uc_intg_musiccast` | works |
| [Yolink Devices](https://github.com/mase1981/uc-intg-yolink) | python | `python -m uc_intg_yolink` | works |
| [Z-Wave](https://github.com/JackJPowell/uc-intg-zwave) | python | `python intg-zwave/driver.py` | works |
| [Zidoo](https://github.com/albaintor/integration-zidoo) | python | `python src/driver.py` | works |
