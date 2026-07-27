#!/bin/bash
set -euo pipefail

# Chrome Web Store packaging script
# Builds a clean, store-ready .zip of the extension (runtime only, no dev tooling).
# Uses keyless manifest from git HEAD and asserts no "key" field in the package.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Create staging directory
STAGING_DIR=$(mktemp -d)
trap "rm -rf '$STAGING_DIR'" EXIT

# Get the keyless manifest from HEAD
MANIFEST_FROM_HEAD=$(git show HEAD:manifest.json)

# Extract version from the manifest
VERSION=$(echo "$MANIFEST_FROM_HEAD" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)".*/\1/')

echo "Building extension v$VERSION..."

# Ensure dist directory exists
mkdir -p dist

# Copy runtime files to staging dir
echo "Copying runtime files..."
cp sw.js "$STAGING_DIR/"

# Copy directories (only if they exist)
for dir in core content ui options assets; do
  if [ -d "$dir" ]; then
    cp -r "$dir" "$STAGING_DIR/"
  fi
done

# Write the keyless manifest from HEAD into staging
echo "$MANIFEST_FROM_HEAD" > "$STAGING_DIR/manifest.json"

# Assert that the built manifest contains no "key" field
KEY_COUNT=$(grep -c '"key"' "$STAGING_DIR/manifest.json" || true)
if [ "$KEY_COUNT" -gt 0 ]; then
  echo "ERROR: Built manifest contains $KEY_COUNT 'key' field(s)!" >&2
  exit 1
fi
echo "✓ Manifest is keyless (key count: $KEY_COUNT)"

# Create the zip file from inside staging so paths are root-relative
OUTPUT_ZIP="dist/medic-tradeboard-v${VERSION}.zip"
(cd "$STAGING_DIR" && zip -r -q "$REPO_ROOT/$OUTPUT_ZIP" .)

# Get the file size
FILE_SIZE=$(stat -f%z "$OUTPUT_ZIP" 2>/dev/null || stat -c%s "$OUTPUT_ZIP")

echo ""
echo "================================"
echo "Package created successfully"
echo "================================"
echo "Output: $OUTPUT_ZIP"
echo "Size: $FILE_SIZE bytes"
echo ""
echo "Contents:"
unzip -l "$OUTPUT_ZIP"
