"""Ollama REST client, connected exactly like the other SK apps:
host/model from ~/.config/skorpion-suite/settings.json, automatic model = the
installed chat model with the most parameters. Standard library only."""

from __future__ import annotations

import json
import socket
import re
import threading
import time
from typing import Iterator

from ..app.config import read_suite_ollama

LIST_TIMEOUT = 4
MAX_LINE = 4 * 1024 * 1024  # one streamed JSON line
INACTIVITY_TIMEOUT = 600  # seconds without a streamed token before giving up


def abort(cancel: threading.Event) -> None:
    """Cancel a streamed request now, even while it waits for the server: shutting the
    socket down ends the blocked read, and Ollama stops generating when the client goes."""
    cancel.set()
    resp = getattr(cancel, "response", None)
    try:
        sock = resp.fp.raw._sock  # http.client response -> socket
        sock.shutdown(socket.SHUT_RDWR)
    except (AttributeError, OSError):
        pass


class OllamaError(Exception):
    """kind: unreachable | no_model | model_missing | timeout | interrupted | server | invalid | empty | cancelled"""

    def __init__(self, kind: str, detail: str = ""):
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind, self.detail = kind, detail


def parameter_count(size: str) -> float:
    m = re.match(r"\s*([\d.]+)\s*([kKmMbBtT])?", size or "")
    if not m:
        return 0.0
    mult = {"k": 1e3, "m": 1e6, "b": 1e9, "t": 1e12}.get((m.group(2) or "").lower(), 1.0)
    return float(m.group(1)) * mult


class Ollama:
    def __init__(self):
        self._caps: dict[str, list] = {}
        self._models: list[dict] | None = None
        self._models_ts = 0.0
        self.lock = threading.Lock()

    # ----------------------------------------------------------- config
    @staticmethod
    def config() -> tuple[str, str]:
        return read_suite_ollama()

    def _url(self, path: str) -> str:
        return self.config()[0].rstrip("/") + path

    def _request(self, path: str, payload: dict | None = None, timeout: float = LIST_TIMEOUT):
        import urllib.error  # imported here: urllib.request costs ~0.3 s at start-up
        import urllib.request
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self._url(path), data=data,
                                     headers={"Content-Type": "application/json"} if data else {})
        try:
            return urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 - local Ollama URL from user config
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            try:
                msg = json.loads(body).get("error", body)
            except ValueError:
                msg = body
            if exc.code == 404:
                raise OllamaError("model_missing", msg) from exc
            raise OllamaError("server", msg) from exc
        except (urllib.error.URLError, OSError) as exc:
            if "timed out" in str(exc):
                raise OllamaError("timeout", str(exc)) from exc
            raise OllamaError("unreachable", str(exc)) from exc

    # ----------------------------------------------------------- models
    def models(self, refresh: bool = False) -> list[dict]:
        with self.lock:
            if self._models is not None and not refresh and time.time() - self._models_ts < 30:
                return self._models
        with self._request("/api/tags") as r:
            try:
                data = json.load(r)
            except ValueError as exc:
                raise OllamaError("invalid", "tags") from exc
        out = []
        for m in data.get("models", []):
            name = m.get("name")
            if not name:
                continue
            out.append({"name": name, "parameter_size": (m.get("details") or {}).get("parameter_size", ""),
                        "family": (m.get("details") or {}).get("family", ""),
                        "capabilities": self.capabilities(name)})
        with self.lock:
            self._models, self._models_ts = out, time.time()
        return out

    def capabilities(self, name: str) -> list:
        if name in self._caps:
            return self._caps[name]
        try:
            with self._request("/api/show", {"model": name}) as r:
                caps = json.load(r).get("capabilities") or []
        except (OllamaError, ValueError):
            caps = []
        if not caps:  # older Ollama: guess from the family
            caps = ["embedding"] if re.search(r"bert|embed|minilm|nomic", name, re.I) else ["completion"]
        self._caps[name] = caps
        return caps

    def chat_model(self) -> str:
        """Model the suite settings name, else the biggest installed chat model."""
        configured = self.config()[1]
        if configured:
            return configured
        chat = [m for m in self.models() if "completion" in m["capabilities"] or "embedding" not in m["capabilities"]]
        if not chat:
            raise OllamaError("no_model")
        return max(chat, key=lambda m: parameter_count(m["parameter_size"]))["name"]

    def embed_model(self) -> str | None:
        emb = [m for m in self.models() if "embedding" in m["capabilities"]]
        if not emb:
            return None
        return max(emb, key=lambda m: parameter_count(m["parameter_size"]))["name"]

    def status(self) -> dict:
        try:
            models = self.models(refresh=True)
        except OllamaError as exc:
            return {"online": False, "error": exc.kind, "host": self.config()[0]}
        try:
            chat = self.chat_model()
        except OllamaError:
            chat = ""
        return {"online": True, "host": self.config()[0], "chatModel": chat, "embedModel": self.embed_model() or "",
                "models": [m["name"] for m in models]}

    # ----------------------------------------------------------- chat
    def chat_stream(self, messages: list[dict], *, model: str | None = None, cancel: threading.Event | None = None,
                    json_mode: bool = False, options: dict | None = None) -> Iterator[str]:
        """Yield content pieces as they arrive. Raises OllamaError (kind) on failure."""
        model = model or self.chat_model()
        payload: dict = {"model": model, "messages": messages, "stream": True}
        if json_mode:
            payload["format"] = "json"
        if options:
            payload["options"] = options
        resp = self._request("/api/chat", payload, timeout=INACTIVITY_TIMEOUT)
        if cancel is not None:
            cancel.response = resp  # lets abort() end a read that is waiting for the server
            if cancel.is_set():
                resp.close()
                raise OllamaError("cancelled")
        got_any = False
        try:
            def lines():
                while True:
                    raw = resp.readline(MAX_LINE + 1)  # bounded: a reply line without an end exhausted memory (B2-14)
                    if not raw:
                        return
                    if len(raw) > MAX_LINE:
                        raise OllamaError("invalid", "reply line too long")
                    yield raw

            for raw in lines():
                if cancel is not None and cancel.is_set():
                    raise OllamaError("cancelled")
                line = raw.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError as exc:
                    raise OllamaError("invalid", line[:200].decode("utf-8", "replace")) from exc
                if obj.get("error"):
                    raise OllamaError("server", obj["error"])
                piece = (obj.get("message") or {}).get("content", "")
                if piece:
                    got_any = True
                    yield piece
                if obj.get("done"):
                    break
            else:
                if cancel is not None and cancel.is_set():
                    raise OllamaError("cancelled")  # abort() closed the stream
                if not got_any:
                    raise OllamaError("interrupted")
        except (OSError, TimeoutError, ValueError) as exc:
            if cancel is not None and cancel.is_set():
                raise OllamaError("cancelled") from exc
            raise OllamaError("timeout" if "timed out" in str(exc) else "interrupted", str(exc)) from exc
        finally:
            resp.close()
        if not got_any:
            raise OllamaError("empty")

    def chat(self, messages: list[dict], **kw) -> str:
        return "".join(self.chat_stream(messages, **kw)).strip()

    def embed(self, texts: list[str], model: str | None = None) -> list[list[float]]:
        model = model or self.embed_model()
        if not model:
            raise OllamaError("no_model", "embedding")
        with self._request("/api/embed", {"model": model, "input": texts}, timeout=120) as r:
            try:
                data = json.load(r)
            except ValueError as exc:
                raise OllamaError("invalid", "embed") from exc
        vecs = data.get("embeddings")
        if not isinstance(vecs, list) or len(vecs) != len(texts):
            raise OllamaError("invalid", "embed size")
        return vecs
