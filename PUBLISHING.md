# Releasing Pegasus

Nothing goes to GitHub until the owner says push.

## Docker image (the hub)

`.github/workflows/docker-image.yml` runs the tests, then builds the hub image for amd64 and arm64 and publishes it to `ghcr.io/sat32blk/pegasus-hub` (and to Docker Hub once `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` are set, as for Stowaway).
- Every push to `main` updates `:latest`.
- A tag like `v0.2.0` also publishes `:0.2.0` and `:0.2`, sets the version shown on the hub page, and builds the Bridge archive (download it from the workflow run and attach it to the release).

**One-time step:** the first published image is private. Open github.com/Sat32blk → **Packages** → **pegasus-hub** → **Package settings** → **Change visibility** → **Public**.

## Releasing the Bridge

The Bridge has its own releases, tagged `bridge-v<version>`, so its numbers never mix with the hub's.

1. Bump the version in `bridge/src/driver.json` (and its `release_date`), `bridge/package.json` and `bridge/src/bin/package.json`. At most 20 characters.
2. `npm test`, commit and push.
3. On GitHub: **Releases → Draft a new release → Choose a tag**, type `bridge-v<version>` (e.g. `bridge-v0.4.1`) and **Create new tag on publish**. Title it `Pegasus Bridge <version>`, list what changed, and **Publish release**.
4. `.github/workflows/bridge-release.yml` checks the tag matches `driver.json`, runs the tests, builds `uc-intg-pegasus-bridge-<version>.tar.gz` and attaches it to the release (a minute or two). That file is what people upload to the remote.

## Releasing the hub

Every push to `main` already publishes `:latest` and `:<hub version>`. For a named release:

1. Bump the version in `hub/package.json` and `package.json`.
2. `npm test`, commit and push.
3. `git tag v<version> && git push origin v<version>` (also publishes `:<major>.<minor>`), and optionally a GitHub release for it with the changes.

## Building the hub without GitHub (e.g. straight on the server)

```sh
cd hub
docker build -t pegasus-hub:local .
```
then use `image: pegasus-hub:local` in the compose file.

## Never commit

`hub/data/` (installed integrations, their settings, the pairing code). `.gitignore` excludes `data/`.
