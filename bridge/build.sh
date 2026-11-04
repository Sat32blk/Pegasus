#!/bin/sh
# Builds the install archive for the remote: dist/uc-intg-pegasus-bridge-<version>.tar.gz
set -e
cd "$(dirname "$0")"
cp ../shared/linkproto.js src/bin/linkproto.js
VERSION=$(node -p "require('./src/driver.json').version")
rm -rf build && mkdir -p build/bin dist
cp src/driver.json build/
cp src/bin/*.js src/bin/package.json build/bin/
cp -r src/bin/standin build/bin/
(cd build/bin && npm install --omit=dev --no-package-lock --no-audit --no-fund && rm -rf node_modules/.bin)
(cd build && tar --owner=0 --group=0 -czf "../dist/uc-intg-pegasus-bridge-$VERSION.tar.gz" driver.json bin)
echo "dist/uc-intg-pegasus-bridge-$VERSION.tar.gz"
