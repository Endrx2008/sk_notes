#!/bin/sh
# Source tarball for the Arch PKGBUILD: committed files + the built web front-end.
# Writes dist/sk_notes-<version>.tar.gz, dist/PKGBUILD (with its sha256) and dist/sk-notes.install.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
VERSION=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' sk_notes/app/config.py)
[ "${1:-}" = "--no-web" ] || node tools/build_web.mjs
[ -f sk_notes/web/dist/main.js ] || { echo "run node tools/build_web.mjs first" >&2; exit 1; }
NAME="sk_notes-$VERSION"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar --prefix="$NAME/" HEAD | tar -C "$TMP" -xf -
mkdir -p "$TMP/$NAME/sk_notes/web"
cp -r sk_notes/web/dist "$TMP/$NAME/sk_notes/web/dist"
mkdir -p dist
tar -C "$TMP" --sort=name --owner=0 --group=0 --numeric-owner -czf "dist/$NAME.tar.gz" "$NAME"
SUM=$(sha256sum "dist/$NAME.tar.gz" | cut -d' ' -f1)
sed -e "s/^pkgver=.*/pkgver=$VERSION/" -e "s/^sha256sums=.*/sha256sums=('$SUM')/" packaging/arch/PKGBUILD > dist/PKGBUILD
cp packaging/arch/sk-notes.install dist/sk-notes.install
echo "built dist/$NAME.tar.gz, dist/PKGBUILD and dist/sk-notes.install (cd dist && makepkg -si)"
