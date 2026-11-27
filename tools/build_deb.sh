#!/bin/sh
# Build dist/sk-notes_<version>_all.deb (Skorpion OS / Debian).
#   tools/build_deb.sh            build the web front-end, then the package
#   tools/build_deb.sh --no-web   reuse sk_notes/web/dist as it is
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
VERSION=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' sk_notes/app/config.py)
[ -n "$VERSION" ] || { echo "cannot read VERSION from sk_notes/app/config.py" >&2; exit 1; }

if [ "${1:-}" != "--no-web" ]; then
    [ -d node_modules ] || npm ci --no-audit --no-fund
    node tools/build_web.mjs
fi
[ -f sk_notes/web/dist/main.js ] || { echo "sk_notes/web/dist is missing: run node tools/build_web.mjs" >&2; exit 1; }

STAGE="$ROOT/build/deb/sk-notes_${VERSION}_all"
rm -rf "$STAGE"
APPDIR="$STAGE/usr/share/sk-notes"
mkdir -p "$APPDIR" "$STAGE/usr/bin" "$STAGE/usr/share/applications" "$STAGE/usr/share/metainfo" \
         "$STAGE/usr/share/icons/hicolor/scalable/apps" "$STAGE/usr/share/doc/sk-notes" "$STAGE/DEBIAN"

# application: Python package, locales and the built web front-end (no sources, tests, caches)
cp main.py "$APPDIR/"
tar -C "$ROOT" --exclude='__pycache__' --exclude='*.pyc' \
    --exclude='sk_notes/web/src' --exclude='sk_notes/web/styles' --exclude='sk_notes/web/tests' \
    -cf - sk_notes | tar -C "$APPDIR" -xf -
find "$APPDIR" -type d -exec chmod 755 {} +
find "$APPDIR" -type f -exec chmod 644 {} +

# SKAI_ Memory: shared Markdown memory (library, JS twin, write helper, first-run setup)
install -d -m 755 "$STAGE/usr/lib/skai" "$STAGE/usr/lib/python3/dist-packages"
install -m 755 skai_memory/skai-memory-write skai_memory/skai-memory-setup "$STAGE/usr/lib/skai/"
install -m 755 skai_memory/skai_memory.py "$STAGE/usr/lib/skai/"
install -m 644 skai_memory/skai_memory_bridge.py "$STAGE/usr/lib/skai/"
install -m 644 skai_memory/skai_memory.js "$STAGE/usr/lib/skai/"
ln -s ../../skai/skai_memory.py "$STAGE/usr/lib/python3/dist-packages/skai_memory.py"
ln -s ../../skai/skai_memory_bridge.py "$STAGE/usr/lib/python3/dist-packages/skai_memory_bridge.py"
ln -s ../lib/skai/skai_memory.py "$STAGE/usr/bin/skai-memory"
install -m 644 skai_memory/README.md "$STAGE/usr/share/doc/sk-notes/README.skai-memory.md"

cat > "$STAGE/usr/bin/sk-notes" <<'SH'
#!/bin/sh
exec /usr/bin/python3 /usr/share/sk-notes/main.py "$@"
SH
chmod 755 "$STAGE/usr/bin/sk-notes"

install -m 644 packaging/skorpion-sk-notes.desktop "$STAGE/usr/share/applications/"
sed -e "s/@VERSION@/$VERSION/" -e "s/@DATE@/$(date -u +%Y-%m-%d)/" packaging/skorpion-sk-notes.metainfo.xml \
    > "$STAGE/usr/share/metainfo/skorpion-sk-notes.metainfo.xml"
install -m 644 sk_notes/web/logo.svg "$STAGE/usr/share/icons/hicolor/scalable/apps/skorpion-sk-notes.svg"
install -m 644 README.md THIRD_PARTY_LICENSES.md "$STAGE/usr/share/doc/sk-notes/"
cat > "$STAGE/usr/share/doc/sk-notes/copyright" <<TXT
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: sk_notes
Upstream-Contact: Enrico Miot (EndrX)

Files: *
Copyright: 2026 Enrico Miot
License: GPL-3.0-or-later
 On Debian systems the full text is in /usr/share/common-licenses/GPL-3.
 Bundled JavaScript libraries and their licences: see THIRD_PARTY_LICENSES.md.
TXT

find "$STAGE" -type d -exec chmod 755 {} +
SIZE=$(du -sk "$STAGE/usr" | cut -f1)
cat > "$STAGE/DEBIAN/control" <<CTL
Package: sk-notes
Version: $VERSION
Section: editors
Priority: optional
Architecture: all
Installed-Size: $SIZE
Depends: python3 (>= 3.11), python3-pyqt6, python3-pyqt6.qtwebengine, python3-yaml, python3-numpy, python3-cryptography, python3-keyring, git, sudo
Recommends: git, libnotify-bin
Suggests: syncthing, pandoc
Maintainer: Enrico Miot <$(git config user.email 2>/dev/null || echo maintainer@localhost)>
Homepage: https://skossite.pages.dev
Description: Markdown notes and knowledge base for Skorpion OS
 sk_notes keeps notes as plain Markdown files in a local folder (a vault):
 internal links and backlinks, graph view, tags, properties, canvas, bases,
 daily notes, templates, full-text search, file history and community plugins,
 with the local SKAI model (Ollama) for summaries and questions about the notes.
 Everything stays on the computer.
CTL

# byte-compile at install time (faster start), clean up on removal
cat > "$STAGE/DEBIAN/postinst" <<'SH'
#!/bin/sh
set -e
if [ "$1" = configure ]; then
    python3 -m compileall -q /usr/share/sk-notes >/dev/null 2>&1 || true
    sh /usr/lib/skai/skai-memory-setup || true   # group 'skai', SKAI_ Memory vault, sudo rule
fi
SH
cat > "$STAGE/DEBIAN/prerm" <<'SH'
#!/bin/sh
set -e
find /usr/share/sk-notes -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
SH
cat > "$STAGE/DEBIAN/postrm" <<'SH'
#!/bin/sh
set -e
# the sudo rule goes away with the program; the vault (user data) and the group stay
if [ "$1" = remove ] || [ "$1" = purge ]; then rm -f /etc/sudoers.d/skai-memory; fi
SH
chmod 755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm" "$STAGE/DEBIAN/postrm"

mkdir -p "$ROOT/dist"
fakeroot dpkg-deb --build -Zxz "$STAGE" "$ROOT/dist/sk-notes_${VERSION}_all.deb" >/dev/null
echo "built dist/sk-notes_${VERSION}_all.deb ($(du -h "$ROOT/dist/sk-notes_${VERSION}_all.deb" | cut -f1))"
