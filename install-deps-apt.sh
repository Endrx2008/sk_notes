#!/bin/sh
# Install the system packages sk_notes needs on Debian / Skorpion OS.
set -e
sudo apt-get install -y python3 python3-pyqt6 python3-pyqt6.qtwebengine python3-pyqt6.qtsvg python3-yaml python3-numpy python3-cryptography python3-keyring git
# cryptography: encrypted vaults; keyring: the Git sync token in the system keyring; git: sync with GitHub/GitLab
# optional: Syncthing sync, UI tests
echo "Optional: sudo apt-get install syncthing python3-websocket nodejs npm"
