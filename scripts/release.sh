#!/usr/bin/env bash
# Builds the macOS app, signs the update bundle, and publishes a GitHub release
# that both new downloads and running copies of egant pick up:
#
#   - egant-macos-arm64.dmg   what the website's download button points at
#   - egant.app.tar.gz (+.sig)  what installed copies download when they update
#   - latest.json             what installed copies ask: "is there a newer one?"
#
# Usage: bump the version in src-tauri/tauri.conf.json (and Cargo.toml,
# package.json), commit and push it, then run scripts/release.sh.
#
# Needs the updater signing key — `npx tauri signer generate -w ~/.tauri/egant-updater.key`
# made it once, and its public half is in tauri.conf.json. Losing it means
# installed copies can never update again, so keep a backup. Override its
# location with TAURI_SIGNING_PRIVATE_KEY_PATH, and its password (if it has one)
# with TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="Dielldev/egant"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="v${VERSION}"

KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/egant-updater.key}"
[ -f "$KEY_PATH" ] || { echo "No signing key at $KEY_PATH" >&2; exit 1; }
# The CLI wants the key's contents here; the *_PATH variant it ignores.
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
unset TAURI_SIGNING_PRIVATE_KEY_PATH

# The release is cut from what is on GitHub, not from what is on this disk.
git fetch -q egant-old main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse egant-old/main)" ]; then
  echo "HEAD is not egant-old/main — push (or check out main) before releasing." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes; the build would not match the tag." >&2
  exit 1
fi
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists — bump the version first." >&2
  exit 1
fi

npm run tauri build -- --bundles app,dmg

BUNDLE="target/release/bundle"
DMG="$(ls "$BUNDLE"/dmg/*.dmg | head -1)"
TARBALL="$BUNDLE/macos/egant.app.tar.gz"
[ -f "$TARBALL" ] && [ -f "$TARBALL.sig" ] || { echo "No updater bundle — is createUpdaterArtifacts on?" >&2; exit 1; }

OUT="$(mktemp -d)"
cp "$DMG" "$OUT/egant-macos-arm64.dmg"
cp "$TARBALL" "$TARBALL.sig" "$OUT/"

PREVIOUS="$(git describe --tags --abbrev=0 2>/dev/null || true)"
NOTES="${NOTES:-$(git log --no-merges --format='- %s' ${PREVIOUS:+$PREVIOUS..}HEAD | head -30)}"

VERSION="$VERSION" NOTES="$NOTES" TAG="$TAG" REPO="$REPO" OUT_DIR="$OUT" SIG_FILE="$OUT/egant.app.tar.gz.sig" \
  node -e '
    const fs = require("fs");
    const e = process.env;
    const manifest = {
      version: e.VERSION,
      notes: e.NOTES,
      pub_date: new Date().toISOString(),
      platforms: {
        "darwin-aarch64": {
          signature: fs.readFileSync(e.SIG_FILE, "utf8").trim(),
          url: `https://github.com/${e.REPO}/releases/download/${e.TAG}/egant.app.tar.gz`,
        },
      },
    };
    fs.writeFileSync(e.OUT_DIR + "/latest.json", JSON.stringify(manifest, null, 2));
  '

gh release create "$TAG" -R "$REPO" --target main --title "egant $VERSION" --notes "$NOTES" \
  "$OUT/egant-macos-arm64.dmg" "$OUT/egant.app.tar.gz" "$OUT/egant.app.tar.gz.sig" "$OUT/latest.json"

echo "Released $TAG: https://github.com/$REPO/releases/tag/$TAG"
