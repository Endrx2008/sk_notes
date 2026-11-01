"""SKAI API for the UI: status, streamed chat (cancellable), embedding index, retrieval."""

from __future__ import annotations

import logging
import threading

from ..app.bridge import ApiError
from .embeddings import EmbeddingIndex, keyword_retrieve
from .memory import get_memory
from .ollama import Ollama, OllamaError, abort

log = logging.getLogger(__name__)


def register(app) -> None:
    r = app.api.route
    ollama = Ollama()
    jobs: dict[str, threading.Event] = {}
    state: dict = {"index": None}
    memory = get_memory()

    def svc():
        if app.service is None:
            raise ApiError("no-vault")
        return app.service

    def index() -> EmbeddingIndex:
        if state["index"] is None:
            state["index"] = EmbeddingIndex(str(svc().vault.config_dir / "embeddings.db"))
        return state["index"]

    @r("ai.status", slow=True)
    def ai_status(p, ctx):
        st = ollama.status()
        st["memory"] = memory.available()
        if app.service is not None:
            try:
                st["index"] = index().status(st.get("embedModel"))
            except Exception:  # noqa: BLE001
                st["index"] = None
        return st

    @r("ai.chat")
    def ai_chat(p, ctx):
        job = str(p.get("id") or "")
        if not job:
            raise ApiError("bad-request")
        cancel = threading.Event()
        jobs[job] = cancel
        messages = p.get("messages") or []
        options = {"temperature": float(p["temperature"])} if p.get("temperature") is not None else None

        def run():
            try:
                for piece in ollama.chat_stream(messages, cancel=cancel, json_mode=bool(p.get("json")), options=options):
                    if cancel.is_set():
                        return
                    app.emit("ai-chunk", {"id": job, "text": piece})
                if not cancel.is_set():
                    app.emit("ai-done", {"id": job})
            except OllamaError as exc:
                if not cancel.is_set():  # a cancel was already reported by ai.cancel
                    app.emit("ai-error", {"id": job, "kind": exc.kind, "detail": exc.detail[:500]})
            except Exception as exc:  # noqa: BLE001
                log.exception("chat failed")
                app.emit("ai-error", {"id": job, "kind": "bug", "detail": str(exc)[:500]})
            finally:
                jobs.pop(job, None)

        threading.Thread(target=run, daemon=True, name=f"skai-{job}").start()
        return {"started": True}

    @r("ai.cancel")
    def ai_cancel(p, ctx):
        job = str(p.get("id"))
        ev = jobs.get(job)
        if ev and not ev.is_set():
            abort(ev)
            app.emit("ai-error", {"id": job, "kind": "cancelled", "detail": ""})  # the UI is free at once
        return bool(ev)

    @r("ai.index.build")
    def ai_index_build(p, ctx):
        model = ollama.embed_model()
        if not model:
            return {"model": None}
        s = svc()

        def run():
            try:
                res = index().build(s, ollama, model, progress=lambda d, t: app.emit("ai-index", {"done": d, "total": t}))
                app.emit("ai-index", {"finished": True, **res})
            except OllamaError as exc:
                app.emit("ai-index", {"error": exc.kind, "detail": exc.detail[:300]})
            except Exception as exc:  # noqa: BLE001
                log.exception("embedding index failed")
                app.emit("ai-index", {"error": "bug", "detail": str(exc)[:300]})

        threading.Thread(target=run, daemon=True, name="skai-index").start()
        return {"model": model, "started": True}

    @r("ai.index.stop")
    def ai_index_stop(p, ctx):
        if state["index"]:
            state["index"].cancel.set()
        return True

    @r("ai.retrieve", slow=True)
    def ai_retrieve(p, ctx):
        query = str(p.get("query", ""))[:2000]
        k = int(p.get("k", 6))
        s = svc()
        model = None
        try:
            model = ollama.embed_model()
        except OllamaError:
            model = None
        # why keywords are used, so the UI says the right thing (A-18)
        reason = "no-model" if not model else ("no-index" if not index().status(model)["chunks"] else "no-match")
        if model and reason != "no-index":
            try:
                vec = ollama.embed([query], model=model)[0]
                hits = index().search(vec, model, k)
                if hits:
                    return {"method": "embeddings", "hits": hits, "memory": memory.recall(query, 3)}
            except OllamaError as exc:
                log.info("embedding search unavailable (%s); keyword fallback", exc.kind)
        return {"method": "keywords", "reason": reason, "hits": keyword_retrieve(s, query, k), "memory": memory.recall(query, 3)}

    @r("ai.memory")
    def ai_memory(p, ctx):
        return {"available": memory.available()}
