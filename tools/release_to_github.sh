#!/bin/sh
# Publish the packages in dist/ as a GitHub release of Endrx2008/sk_notes (sign-in through the website).
# Build them first: tools/build_deb.sh and tools/build_tarball.sh.
set -eu
OWNER=Endrx2008
REPO=sk_notes
cd "$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(sed -n 's/^VERSION = "\(.*\)"/\1/p' sk_notes/app/config.py)
FILES="dist/sk-notes_${VERSION}_all.deb dist/sk_notes-${VERSION}.tar.gz dist/PKGBUILD dist/sk-notes.install"
for f in $FILES; do [ -f "$f" ] || { echo "missing $f: build the packages first" >&2; exit 1; }; done
command -v gh >/dev/null || { echo "install the GitHub CLI first: sudo apt install gh" >&2; exit 1; }

LOGGED_IN_BEFORE=0
gh auth status -h github.com >/dev/null 2>&1 && LOGGED_IN_BEFORE=1
[ "$LOGGED_IN_BEFORE" = 1 ] || gh auth login -h github.com -p https -w
[ "$(gh api user -q .login)" = "$OWNER" ] || { echo "logged in as the wrong account: run 'gh auth logout'" >&2; exit 1; }

# shellcheck disable=SC2086
gh release create "v$VERSION" $FILES --repo "$OWNER/$REPO" --target main \
    --title "sk_notes $VERSION" \
    --notes "Debian package (sudo apt install ./sk-notes_${VERSION}_all.deb) and Arch files (PKGBUILD + source tarball + sk-notes.install: makepkg -si). Includes SKAI_ Memory. After installing: sudo usermod -aG skai <user>."
echo "done: https://github.com/$OWNER/$REPO/releases/tag/v$VERSION" >&2

if [ "$LOGGED_IN_BEFORE" = 0 ]; then
    printf 'Forget this login on the computer now? [Y/n] ' >&2
    read -r a
    case "$a" in n|N) ;; *) gh auth logout -h github.com >/dev/null 2>&1 && echo "logged out" >&2 ;; esac
fi
