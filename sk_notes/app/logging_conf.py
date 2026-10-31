"""Logging: console + rotating file in ~/.cache/sk_notes/sk_notes.log (suite convention)."""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler

from .config import log_file

FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"


def setup_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if root.handlers:
        return
    root.setLevel(logging.DEBUG if os.environ.get("SK_NOTES_DEBUG") else level)
    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter(FORMAT))
    root.addHandler(console)
    try:
        fh = RotatingFileHandler(log_file(), maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8")
        fh.setFormatter(logging.Formatter(FORMAT))
        root.addHandler(fh)
    except OSError:
        root.warning("cannot write the log file %s", log_file())
