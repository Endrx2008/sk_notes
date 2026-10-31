#!/usr/bin/env python3
# sk_notes – local Markdown notes for Skorpion OS
# Copyright (C) 2026 Enrico Miot
# SPDX-License-Identifier: GPL-3.0-or-later
"""Entry point: ``python3 main.py [--vault PATH]``."""

from __future__ import annotations

import argparse
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(prog="sk-notes", description="sk_notes – Markdown notes and knowledge base")
    parser.add_argument("--vault", help="open this folder as a vault")
    parser.add_argument("uri", nargs="?", help="sknotes:// link to open")
    args = parser.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from sk_notes.app.logging_conf import setup_logging
    setup_logging()

    if args.uri:
        vault = _vault_for_link(args.uri, args.vault)
        if vault and _forward_link(vault, args.uri):
            return 0  # the process that has this vault open takes it
        args.vault = args.vault or vault

    from sk_notes.app.bridge import register_scheme
    register_scheme()  # before QApplication

    from PyQt6.QtCore import Qt
    from PyQt6.QtWidgets import QApplication
    from sk_notes.app import config

    QApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    qapp = QApplication(sys.argv)
    qapp.setApplicationName(config.APP_NAME)
    qapp.setOrganizationName("Skorpion")
    qapp.setApplicationVersion(config.VERSION)
    qapp.setDesktopFileName(config.APP_ID)

    import logging
    from sk_notes.app.api_core import process_age
    log = logging.getLogger("sk_notes.startup")
    log.debug("startup: QApplication at %.2fs", process_age() or 0)
    from sk_notes.app.application import SkNotesApp
    app = SkNotesApp(qapp, vault_path=args.vault)
    log.debug("startup: app and vault at %.2fs", process_age() or 0)
    win = app.new_window()
    win.view.setZoomFactor(app.settings.zoom)
    win.load("" if app.service else "vaults")
    win.show()
    log.debug("startup: window shown at %.2fs", process_age() or 0)
    if args.uri:
        app.handle_uri(args.uri)  # delivered once the page is ready
    code = qapp.exec()
    app.quit()
    return code


def _vault_for_link(link: str, explicit: str | None) -> str | None:
    """Vault a sknotes:// link points to (known vaults only), else the last one used."""
    from sk_notes.app import config, uri
    settings = config.GlobalSettings.load()
    try:
        _action, params = uri.parse(link)
    except uri.UriError:
        return explicit or settings.last_vault
    known = list(settings.vaults)
    return explicit or uri.find_vault(params, known) or settings.last_vault


def _forward_link(vault: str, link: str) -> bool:
    """Give the link to a running sk_notes that has `vault` open; True if one took it."""
    from PyQt6.QtNetwork import QLocalSocket
    from sk_notes.app import uri
    sock = QLocalSocket()
    sock.connectToServer(uri.server_name(str(os.path.realpath(vault))))
    if not sock.waitForConnected(500):
        return False
    sock.write(link.encode())
    sock.flush()
    sock.waitForBytesWritten(1000)
    sock.disconnectFromServer()
    return True


if __name__ == "__main__":
    sys.exit(main())
