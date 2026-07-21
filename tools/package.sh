#!/usr/bin/env bash
# Build the Chrome Web Store upload zip.
#
# Ships ONLY runtime files. Tests, fixtures, tooling and docs are deliberately
# excluded: anonymized board fixtures are still board-shaped data, and there is
# no reason to hand them to a store reviewer or ship them to every user.
#
#   ./tools/package.sh   ->  dist/medic-tradeboard-<version>.zip
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(node -e 'process.stdout.write(require("./manifest.json").version)')
OUT="dist/medic-tradeboard-${VERSION}.zip"

rm -rf dist && mkdir -p dist

zip -q -r "$OUT" \
  manifest.json \
  sw.js \
  content core ui options assets \
  -x '*.DS_Store' -x '__MACOSX*'

echo "$OUT"
unzip -l "$OUT" | tail -1

# Fail loudly rather than ship a secret. A signing key or credential inside the
# package would be published to every user who installs it.
if unzip -l "$OUT" | grep -qiE 'key\.pem|key\.pub|\.creds|creds\.json'; then
  echo "ABORT: key or credential file found in package" >&2
  exit 1
fi

# The store build must not carry the placeholder OAuth client id.
if grep -q 'TODO_REPLACE' manifest.json; then
  echo "NOTE: manifest still has the placeholder oauth2.client_id." >&2
  echo "      Fine for the FIRST upload (which is what mints the extension ID)," >&2
  echo "      but replace it before submitting for review." >&2
fi
