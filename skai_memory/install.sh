#!/bin/sh
# Install SKAI_ Memory from a source checkout (the .deb / PKGBUILD do the same). Run as root: sudo sh install.sh
set -eu
[ "$(id -u)" = 0 ] || { echo "run as root: sudo sh install.sh" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
LIB=/usr/lib/skai
install -d -m 0755 "$LIB"
install -m 0755 "$here/skai-memory-write" "$here/skai-memory-setup" "$LIB/"
install -m 0644 "$here/skai_memory.py" "$here/skai_memory.js" "$LIB/"
py=$(python3 -c 'import sysconfig;print(sysconfig.get_paths()["purelib"])')
ln -sf "$LIB/skai_memory.py" "$py/skai_memory.py"
ln -sf "$LIB/skai_memory.py" /usr/bin/skai-memory
exec sh "$LIB/skai-memory-setup"
