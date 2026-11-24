"""Global (not per-vault) paths and settings, plus the shared Skorpion files sk_notes
reads: the SKAI theme switch and the suite's Ollama settings."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

APP_NAME = "sk_notes"
APP_ID = "skorpion-sk-notes"  # Wayland app_id / X11 class, matches the .desktop file
VERSION = "1.2.1"

# Shared Skorpion files (see docs/research/skorpion-apps.md)
# shared with the other Skorpion apps; resolved through XDG like every suite config (B-24)
_XDG_CONFIG = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
SKAI_THEME_FILE = _XDG_CONFIG / "pylauncher_settings" / "theme_config.json"
SUITE_SETTINGS_FILE = _XDG_CONFIG / "skorpion-suite" / "settings.json"
DEFAULT_OLLAMA_HOST = "http://localhost:11434"


def _xdg(env: str, fallback: str) -> Path:
    base = os.environ.get(env) or str(Path.home() / fallback)
    p = Path(base) / APP_NAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def config_dir() -> Path:
    return _xdg("XDG_CONFIG_HOME", ".config")


def cache_dir() -> Path:
    return _xdg("XDG_CACHE_HOME", ".cache")


def data_dir() -> Path:
    return _xdg("XDG_DATA_HOME", ".local/share")


def log_file() -> Path:
    return cache_dir() / f"{APP_NAME}.log"


@dataclass
class GlobalSettings:
    language: str = ""  # "" = follow the system
    vaults: dict = field(default_factory=dict)  # path -> {"ts": last open ms, "open": bool}
    last_vault: str = ""
    window: dict = field(default_factory=dict)  # geometry
    zoom: float = 1.0
    crypt_lock_after: int = 5  # minutes without use before an encrypted vault locks (0 = when minimised, -1 = never)

    @classmethod
    def load(cls) -> "GlobalSettings":
        p = config_dir() / "settings.json"
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError
        except (OSError, ValueError):
            return cls()
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

    def save(self) -> None:
        p = config_dir() / "settings.json"
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)


def read_skai_theme() -> str:
    """'dark' or 'light' from the SKAI theme switch shared by every SKAI app."""
    try:
        theme = json.loads(SKAI_THEME_FILE.read_text(encoding="utf-8")).get("theme", "dark")
    except (OSError, ValueError, AttributeError):
        return "dark"
    return theme if theme in ("dark", "light") else "dark"


_LOCAL = {"localhost", "127.0.0.1", "::1", "[::1]"}
_OLLAMA_PATHS = {"", "/api/version", "/api/tags", "/api/ps", "/api/show", "/api/chat", "/api/generate", "/api/embed",
                 "/api/embeddings", "/v1/models", "/v1/chat/completions", "/v1/completions", "/v1/embeddings"}


def is_ollama_url(url: str) -> bool:
    """True if `url` points at the configured Ollama server: the one local service the
    page and plugins may reach without the network permission."""
    from urllib.parse import urlsplit
    try:
        u, o = urlsplit(url), urlsplit(read_suite_ollama()[0])
        same_host = u.hostname == o.hostname or {u.hostname, o.hostname} <= _LOCAL
        # only asking the models: /api/pull, /api/push, /api/create… would let page code make
        # Ollama contact any registry (B2-9)
        return (u.scheme in ("http", "https") and same_host and (u.port or 80) == (o.port or 80)
                and (u.path or "/").rstrip("/") in _OLLAMA_PATHS)
    except ValueError:
        return False


def read_suite_ollama() -> tuple[str, str]:
    """(host, model) from the Skorpion suite settings; model "" = automatic."""
    try:
        data = json.loads(SUITE_SETTINGS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError
    except (OSError, ValueError):
        data = {}
    host = data.get("ollama_host") or DEFAULT_OLLAMA_HOST
    model = data.get("ollama_model") or ""
    return str(host), str(model)
