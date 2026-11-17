"""Encrypted vaults in the desktop app: opening, saving, locking (core/crypt.py does the files).

One vault per process, like any vault of the desktop app. While an encrypted vault is
open its files are decrypted under the user's data directory (mode 0700); every change of
the vault brings the encrypted file up to date a few seconds later, and once more when
the window is closed. The vault locks itself after the chosen time without use (no key
pressed, no mouse moved in sk_notes), or when the window is minimised if the user chose
so; locked, the decrypted files are removed and the key is forgotten.

API (same names as the Android app, so the screens work alike):
  vaults.open {path, password}   vaults.create {.., password} → {recovery}   vaults.lock
  vaults.changePassword / vaults.recover / vaults.newRecovery
  vaults.encrypt / vaults.decrypt   vaults.remember   crypt.settings / crypt.setLockAfter / crypt.takeNotes
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
from pathlib import Path

from PyQt6.QtCore import QEvent, QObject, Qt, QTimer, pyqtSignal, pyqtSlot

from ..core import crypt
from . import config
from .bridge import ApiError, Deferred

log = logging.getLogger(__name__)
LOCK_CHOICES = [0, 1, 5, 15, 60, -1]  # minutes without use; 0 = when the window is minimised; -1 = never
INPUT = {QEvent.Type.KeyPress, QEvent.Type.MouseButtonPress, QEvent.Type.MouseMove, QEvent.Type.Wheel, QEvent.Type.TouchBegin}


class _Hop(QObject):
    """Runs a function on the thread this object lives in (the UI thread): a queued call to
    a real slot. (A plain lambda connected to the signal would run in the emitting thread.)"""

    done = pyqtSignal(object)

    def __init__(self):
        super().__init__()
        self.done.connect(self._run, Qt.ConnectionType.QueuedConnection)

    @pyqtSlot(object)
    def _run(self, fn):
        fn()


# "wrong-password" already means the sudo password of SKAI_ Memory in the desktop app
_CODES = {"wrong-password": "vault-wrong-password"}


def _crypt_error(exc: "crypt.CryptError") -> ApiError:
    return ApiError(_CODES.get(exc.code, exc.code), exc.detail)


def _api_error(exc: Exception) -> ApiError:
    if isinstance(exc, ApiError):
        return exc
    if isinstance(exc, crypt.CryptError):
        return _crypt_error(exc)
    if isinstance(exc, OSError):
        return ApiError("read-only", str(exc))
    return ApiError("error", str(exc))


class CryptSession(QObject):
    def __init__(self, app):
        super().__init__()
        self.app = app
        self.vault: crypt.OpenVault | None = None
        self.locked: dict | None = None  # {path, name}: an encrypted vault waiting for its password
        self.notes: dict | None = None  # told once after opening: conflict copies, a save cut short
        self.last_input = time.monotonic()
        self.hop = _Hop()
        app.qapp.installEventFilter(self)
        self.ticker = QTimer(self)
        self.ticker.setInterval(15_000)
        self.ticker.timeout.connect(self._tick)
        self.ticker.start()
        threading.Thread(target=self._tidy, daemon=True).start()

    # ------------------------------------------------------------- helpers
    @staticmethod
    def private_root() -> Path:
        return config.data_dir()

    def where(self, blob) -> crypt.Places:
        return crypt.places(self.private_root(), Path(blob).resolve())

    def _tidy(self) -> None:
        try:
            crypt.tidy(self.private_root(), self.vault.where.dir if self.vault else None)
        except Exception:  # noqa: BLE001
            log.warning("encrypted folders not tidied", exc_info=True)

    def in_background(self, work, done=None) -> Deferred:
        """Run `work()` in a thread (key derivation, decryption), then `done(result)` on the UI
        thread; the API reply waits for both."""
        d = Deferred()

        def run():
            try:
                res = work()
            except Exception as exc:  # noqa: BLE001
                err = _api_error(exc)
                if not isinstance(exc, (ApiError, crypt.CryptError)):
                    log.exception("encrypted vault")
                self.hop.done.emit(lambda: d.reject(err.code, err.detail))
                return

            def finish():
                try:
                    d.resolve(done(res) if done else res)
                except Exception as exc:  # noqa: BLE001
                    err = _api_error(exc)
                    if not isinstance(exc, (ApiError, crypt.CryptError)):
                        log.exception("encrypted vault")
                    d.reject(err.code, err.detail)
            self.hop.done.emit(finish)
        threading.Thread(target=run, daemon=True).start()
        return d

    def eventFilter(self, obj, ev):  # noqa: N802 - Qt API
        if ev.type() in INPUT:
            self.last_input = time.monotonic()
        return False

    def lock_after(self) -> int:
        v = getattr(self.app.settings, "crypt_lock_after", 5)
        return v if v in LOCK_CHOICES else 5

    # ------------------------------------------------------------- opening
    def start_locked(self, blob) -> None:
        self.locked = {"path": str(Path(blob).resolve()), "name": crypt.blob_name(blob)}

    def attach(self, v: crypt.OpenVault) -> dict:
        """An unlocked vault becomes the vault of this process (UI thread)."""
        self.vault = v
        self.locked = None
        self.notes = {"conflicts": list(v.conflicts), "torn": bool(v.torn)}
        v.before_seal = self._checkpoint
        self.last_input = time.monotonic()
        return self.app.open_vault(str(v.where.work), record=str(v.blob))

    def _checkpoint(self) -> None:
        """The note history is SQLite in WAL mode: its changes go into the main file before it is copied."""
        s = self.app.service
        if s is not None and getattr(s.history, "db", None) is not None:
            s.history.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def touch(self) -> None:
        if self.vault:
            self.vault.touch()

    # ------------------------------------------------------------- locking
    def lock(self, reload: bool = True) -> bool:
        v = self.vault
        if not v:
            return False
        v.cancel_timer()
        v.seal()
        if v.changed():
            v.seal()
        self.app.close_vault()
        self.vault = None
        crypt.wipe(v.where.dir)
        self.locked = {"path": str(v.blob), "name": crypt.blob_name(v.blob)}
        if reload:
            for w in list(self.app.windows):
                w.view.reload()
        return True

    def shutdown(self) -> None:
        """The app closes: everything into the file, nothing readable left behind."""
        v = self.vault
        if not v:
            return
        try:
            v.cancel_timer()
            v.seal()
        except Exception:  # noqa: BLE001
            log.exception("encrypted vault not saved at exit: its changes stay in the private folder and are saved at the next opening")
            return
        self.app.close_vault()
        self.vault = None
        crypt.wipe(v.where.dir)

    def _tick(self) -> None:
        if not self.vault:
            return
        limit = self.lock_after()
        if limit < 0:
            return
        if limit == 0:
            wins = [w for w in self.app.windows if not w.popout]
            if wins and all(w.isMinimized() for w in wins):
                log.info("encrypted vault locked: window minimised")
                self.lock()
            return
        if time.monotonic() - self.last_input >= limit * 60:
            log.info("encrypted vault locked after %s minutes without use", limit)
            self.lock()


def register(app) -> None:
    r = app.api.route
    cs: CryptSession = app.crypt_session

    def app_only(ctx):
        if ctx.plugin:
            raise ApiError("permission-denied")

    def blob_of(p) -> tuple[Path, crypt.OpenVault | None]:
        path = Path(str(p.get("path") or (cs.vault.blob if cs.vault else ""))).expanduser()
        if not crypt.is_blob(path):
            raise ApiError("not-found", str(path))
        open_v = cs.vault if cs.vault and Path(cs.vault.blob) == path.resolve() else None
        return path.resolve(), open_v

    def guarded(fn):
        def run(*a, **kw):
            try:
                return fn(*a, **kw)
            except crypt.CryptError as exc:
                raise _crypt_error(exc) from exc
        return run

    @r("vaults.lock")
    def lock(p, ctx):
        app_only(ctx)
        return cs.lock()

    @r("vaults.remember")
    def remember(p, ctx):
        app_only(ctx)
        path = Path(str(p.get("path") or "")).expanduser().resolve()
        if not crypt.is_blob(path) or not path.is_file():
            raise ApiError("not-found", str(path))
        app.settings.vaults.setdefault(str(path), {"ts": int(time.time() * 1000)})
        app.settings.save()
        return True

    @r("vaults.pickVaultFile")
    def pick_vault_file(p, ctx):
        """An encrypted vault file (copied from another device, for example)."""
        app_only(ctx)
        from PyQt6.QtWidgets import QFileDialog
        parent = app.windows[0] if app.windows else None
        f, _ = QFileDialog.getOpenFileName(parent, p.get("title", ""), str(Path.home()), "sk_notes (*.skvault)")
        return f or None

    @r("vaults.changePassword", slow=True)
    @guarded
    def change_password(p, ctx):
        app_only(ctx)
        path, open_v = blob_of(p)
        return crypt.change_password(path, p.get("old"), p.get("password"), open_v)

    @r("vaults.recover", slow=True)
    @guarded
    def recover(p, ctx):
        app_only(ctx)
        path, open_v = blob_of(p)
        return crypt.recover_password(path, p.get("code"), p.get("password"), open_v)

    @r("vaults.newRecovery", slow=True)
    @guarded
    def new_recovery(p, ctx):
        app_only(ctx)
        path, open_v = blob_of(p)
        return crypt.new_recovery_code(path, p.get("password"), open_v)

    @r("crypt.settings", slow=True)
    def settings(p, ctx):
        app_only(ctx)
        return {"lockAfter": cs.lock_after(), "choices": LOCK_CHOICES, "desktop": True,
                "recovery": crypt.has_recovery(cs.vault.blob) if cs.vault else False}

    @r("crypt.setLockAfter")
    def set_lock_after(p, ctx):
        app_only(ctx)
        m = int(p.get("minutes", 5))
        if m in LOCK_CHOICES:
            app.settings.crypt_lock_after = m
            app.settings.save()
        return cs.lock_after()

    @r("crypt.takeNotes")
    def take_notes(p, ctx):
        app_only(ctx)
        n, cs.notes = cs.notes, None
        return n

    @r("vaults.encrypt")
    def encrypt(p, ctx):
        """The open (normal) vault made into an encrypted vault file, checked note by note
        against the folder; with removeOriginal the readable folder is deleted then."""
        app_only(ctx)
        if cs.vault:
            raise ApiError("already-encrypted")
        s = app.service
        if s is None:
            raise ApiError("no-vault")
        folder = Path(s.vault.root)
        parent = Path(str(p.get("parent") or folder.parent)).expanduser().resolve()
        if parent == folder or folder in parent.parents:
            raise ApiError("into-itself-vault", str(parent))
        blob = parent / f"{folder.name}.{crypt.BLOB_EXT}"
        try:
            crypt.check_password(p.get("password"))
        except crypt.CryptError as exc:
            raise ApiError(exc.code, exc.detail) from exc
        if blob.exists():
            raise ApiError("already-exists", str(blob))
        try:
            s.history.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:  # noqa: BLE001
            pass
        remove = bool(p.get("removeOriginal"))

        def work():
            return crypt.encrypt_folder(folder, None, blob, p.get("password"), cs.where(blob))

        def done(res):
            v, code = res
            app.close_vault()
            if remove:
                shutil.rmtree(folder, ignore_errors=True)
                from ..core.secrets import delete_secret
                from ..extras.sync_api import secret_name
                delete_secret(secret_name(folder))
                app.settings.vaults.pop(str(folder), None)
            cs.attach(v)
            return {"opened": "here", "path": str(blob), "recovery": code}
        return cs.in_background(work, done)

    @r("vaults.decrypt")
    def decrypt(p, ctx):
        """The open encrypted vault turned back into a normal folder (password asked again)."""
        app_only(ctx)
        v = cs.vault
        if not v:
            raise ApiError("not-encrypted")
        parent = Path(str(p.get("parent") or Path(v.blob).parent)).expanduser().resolve()
        target = parent / crypt.blob_name(v.blob)
        if crypt.places(cs.private_root(), v.blob).dir in target.parents:
            raise ApiError("permission-denied", str(target))
        if target.exists() and (not target.is_dir() or any(target.iterdir())):
            raise ApiError("already-exists", str(target))
        remove = bool(p.get("removeEncrypted"))

        def work():
            crypt.verify_password(v.blob, p.get("password"))
            cs._checkpoint()
            crypt.decrypt_to(v, target)
            return True

        def done(_):
            blob = Path(v.blob)
            v.cancel_timer()
            app.close_vault()
            cs.vault = None
            crypt.wipe(v.where.dir)
            if remove:
                for f in (blob, Path(str(blob) + ".old"), Path(str(blob) + ".tmp")):
                    f.unlink(missing_ok=True)
                app.settings.vaults.pop(str(blob), None)
            app.open_vault(str(target))
            return {"opened": "here", "path": str(target)}
        return cs.in_background(work, done)
