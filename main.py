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

    from sk_notes.app.application import SkNotesApp
    app = SkNotesApp(qapp, vault_path=args.vault)
    win = app.new_window()
    win.view.setZoomFactor(app.settings.zoom)
    win.load("" if app.service else "vaults")
    win.show()
    code = qapp.exec()
    app.quit()
    return code


if __name__ == "__main__":
    sys.exit(main())
