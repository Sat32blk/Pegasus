# Pegasus Hub: runs Unfolded Circle integrations (Node.js and Python) for the Pegasus Bridge.
# Built for amd64 and arm64. On arm64 (e.g. a Raspberry Pi) integrations built for the remote's
# processor run as they are; on amd64 Python integrations are installed from source.
FROM node:22-trixie-slim

# python3 + venv for Python integrations (Debian 13: Python 3.13), git for installing from GitHub,
# build tools for the occasional native Python / Node module, tini to forward signals and reap
# processes. setpriv (util-linux, already in the base) drops root in docker-entrypoint.sh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip python3-dev git ca-certificates tini \
      build-essential libffi-dev libssl-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

# Shown on the hub page; set by the GitHub build from the release tag.
ARG VERSION=""
# PEGASUS_PORT (9600) and PEGASUS_DATA (/data) have their defaults in the hub itself, so a
# compose file from before the rename (PEGASIS_*) still wins.
ENV PEGASUS_VERSION=${VERSION} \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    MALLOC_ARENA_MAX=2
VOLUME /data
EXPOSE 9600

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+((process.env.PEGASUS_PORT||process.env.PEGASIS_PORT)||9600)+'/api/status').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
