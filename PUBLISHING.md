# Releasing Pegasis

Nothing goes to GitHub until the owner says push.

## Docker image (the hub)

`.github/workflows/docker-image.yml` runs the tests, then builds the hub image for amd64 and arm64 and publishes it to `ghcr.io/sat32blk/pegasis-hub` (and to Docker Hub once `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` are set, as for Stowaway).
- Every push to `main` updates `:latest`.
- A tag like `v0.2.0` also publishes `:0.2.0` and `:0.2`, sets the version shown on the hub page, and builds the Bridge archive (download it from the workflow run and attach it to the release).

**One-time step:** the first published image is private. Open github.com/Sat32blk → **Packages** → **pegasis-hub** → **Package settings** → **Change visibility** → **Public**.

## Making a release

1. Bump the version in `hub/package.json`, `bridge/src/driver.json` (and its `release_date`), `bridge/package.json`, `bridge/src/bin/package.json` and `package.json`. The Bridge version must be 20 characters or fewer.
2. `npm test`, commit and push.
3. `git tag v0.2.0 && git push origin v0.2.0`.
4. On GitHub, **Releases → Draft a new release**: choose the tag, list what changed, attach `uc-intg-pegasis-bridge-<version>.tar.gz`.

## Building the hub without GitHub (e.g. straight on the server)

```sh
cd hub
docker build -t pegasis-hub:local .
```
then use `image: pegasis-hub:local` in the compose file.

## Never commit

`hub/data/` (installed integrations, their settings, the pairing code). `.gitignore` excludes `data/`.
