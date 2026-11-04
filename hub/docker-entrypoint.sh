#!/bin/sh
# Pegasus Hub start-up.
#
# Integrations are third-party code, so the hub (and every integration it starts) runs as an
# ordinary user, not root: PUID / PGID (default 1000 / 100, the usual first user and "users" group
# on OpenMediaVault). Set PUID=0 to run as root.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-100}"
DATA="${PEGASUS_DATA:-${PEGASIS_DATA:-/data}}" # PEGASIS_*: compose files from before the rename

mkdir -p "$DATA/home" "$DATA/.cache"

# Tools that write to $HOME (npm, pip, git) use the data folder, never the image.
export HOME="$DATA/home"
export npm_config_cache="$DATA/.cache/npm"
export npm_config_update_notifier=false
export PIP_DISABLE_PIP_VERSION_CHECK=1
export GIT_TERMINAL_PROMPT=0

if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
  # Give the data folder to that user (only what isn't theirs yet, so restarts stay quick).
  find "$DATA" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all -- "$@"
fi
exec "$@"
