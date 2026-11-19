"""Encrypted vaults: a whole vault kept as one encrypted file ``<Name>.skvault``.

Same file format as sk_notes for Android (android/web/src/backend/vault-crypt.js): a
vault encrypted on the phone opens here and the other way round.

    "SKNVAULT1\\n"  u32 length  header (JSON)
    segments, one per save:  "SEG2"  nonce (8 bytes)  pieces
    a piece:  u32 length  AES-256-GCM(up to 1 MiB of records)

Records: a file (path, time, bytes), a folder, a removal, the end of the segment. Each
piece is authenticated with its segment number, its own number and whether it is the
last of its segment (swapped, moved or dropped pieces are refused). A save cut short
leaves an incomplete last piece: noticed, and the file is written whole again.

The pieces are encrypted with a random vault key; the header holds that key encrypted
with a key made from the password (PBKDF2-HMAC-SHA256, 600 000 rounds) and with one made
from the recovery code shown when the vault is encrypted.

While the vault is open its files are decrypted into a private folder of the user's data
directory (mode 0700) and sk_notes works there as with any vault. Only what changed is
added to the file at each save; it is written whole again when old versions take more
room than the vault. Paths in records: ``v/<rel>`` for the vault, ``h/<rel>`` for the
note history kept by the Android app (stored and given back unchanged here).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import shutil
import struct
import threading
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger(__name__)

BLOB_EXT = "skvault"
MAGIC = b"SKNVAULT1\n"
SEG = b"SEG2"
PIECE = 1024 * 1024
MB = 1024 * 1024
ROUNDS = 600_000
RECOVERY_ROUNDS = 100_000
MIN_PASSWORD = 8
CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SKIP_NAMES = {".git", ".trash"}  # stay out of the file (repository data of other tools, the trash)


class CryptError(Exception):
    """Error with a code the UI has a text for (wrong-password, crypt-damaged, ...)."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code, self.detail = code, detail


def is_blob(path) -> bool:
    return str(path).lower().endswith("." + BLOB_EXT)


def blob_name(path) -> str:
    name = Path(path).name
    return name[: -len(BLOB_EXT) - 1] if is_blob(name) else name


def check_password(password) -> str:
    p = unicodedata.normalize("NFC", str(password or ""))
    if len(p) < MIN_PASSWORD:
        raise CryptError("password-short", str(MIN_PASSWORD))
    return p


def _skipped(prefix: str, rel: str, is_dir: bool) -> bool:
    """Files that never go into the vault file."""
    parts = rel.split("/")
    name = parts[-1]
    if name.startswith(".skn-tmp-"):
        return True
    if prefix != "v":
        return False
    if any(p in SKIP_NAMES for p in parts):
        return True
    # caches of the desktop app, made again when needed, and SQLite's side files
    if not is_dir and len(parts) == 2 and parts[0] == ".sk_notes":
        if name.startswith(("cache.db", "embeddings.db")) or name.endswith(("-wal", "-shm", "-journal")):
            return True
    return False


def _stamp() -> str:
    return time.strftime("%Y-%m-%d %H.%M")


def beside_name(path: Path, what: str) -> Path:
    """'Name (<what> <date>).ext' beside `path`, a name not in use."""
    base, ext = (path.stem, path.suffix) if path.suffix else (path.name, "")
    when = _stamp()
    n = 1
    while True:
        c = path.with_name(f"{base} ({what} {when}{' ' + str(n) if n > 1 else ''}){ext}")
        if not c.exists():
            return c
        n += 1


# ---------------------------------------------------------------- keys
def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _unb64(s) -> bytes:
    try:
        return base64.b64decode(str(s or ""), validate=False)
    except (ValueError, TypeError) as exc:
        raise CryptError("crypt-damaged", "base64") from exc


def _slow_key(secret: str, salt: bytes, rounds: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt, rounds, 32)


def _wrap_with(raw: bytes, secret: str, rounds: int) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    key = AESGCM(_slow_key(secret, salt, rounds)).encrypt(iv, raw, None)
    return {"kdf": {"name": "PBKDF2", "hash": "SHA-256", "iterations": rounds, "salt": _b64(salt)},
            "wrap": {"iv": _b64(iv), "key": _b64(key)}}


def _unwrap_with(part: dict, secret: str, wrong: str) -> bytes:
    kdf = (part or {}).get("kdf") or {}
    rounds = int(kdf.get("iterations") or 0)
    if kdf.get("name") != "PBKDF2" or not 1000 <= rounds <= 50_000_000 or not (part.get("wrap") or {}).get("key"):
        raise CryptError("crypt-damaged", "header")
    kek = _slow_key(secret, _unb64(kdf.get("salt")), rounds)
    try:
        return AESGCM(kek).decrypt(_unb64(part["wrap"].get("iv")), _unb64(part["wrap"]["key"]), None)
    except (InvalidTag, ValueError) as exc:
        raise CryptError(wrong) from exc


def _norm(password) -> str:
    return unicodedata.normalize("NFC", str(password or ""))


def _wrap_password(raw: bytes, password: str) -> dict:
    return _wrap_with(raw, _norm(password), ROUNDS)


def _unwrap_password(header: dict, password) -> bytes:
    return _unwrap_with(header, _norm(password), "wrong-password")


def _new_code() -> str:
    b = os.urandom(24)
    s = "".join(CODE_CHARS[x % 32] for x in b)
    return "-".join(s[i:i + 4] for i in range(0, 24, 4))


def _clean_code(code) -> str:
    s = "".join(ch for ch in str(code or "").upper() if ch.isascii() and ch.isalnum())
    return s.replace("O", "0").replace("I", "1")


def _wrap_recovery(raw: bytes) -> tuple[str, dict]:
    code = _new_code()
    return code, _wrap_with(raw, _clean_code(code), RECOVERY_ROUNDS)


def _unwrap_recovery(header: dict, code) -> bytes:
    if not header.get("recovery"):
        raise CryptError("no-recovery")
    return _unwrap_with(header["recovery"], _clean_code(code), "wrong-code")


def _new_header(name: str, raw: bytes, password: str) -> tuple[dict, str]:
    code, rec = _wrap_recovery(raw)
    header = {"v": 2, "app": "sk_notes", "name": name, **_wrap_password(raw, password), "recovery": rec,
              "data": {"cipher": "AES-256-GCM", "piece": PIECE, "form": "segments"}}
    return header, code


# ---------------------------------------------------------------- the file
def read_header(blob: Path) -> tuple[dict, int, int]:
    """(header, offset of the body, size of the file)."""
    blob = Path(blob)
    if not blob.is_file():
        raise CryptError("not-found", str(blob))
    size = blob.stat().st_size
    with open(blob, "rb") as f:
        head = f.read(len(MAGIC) + 4)
        if len(head) < len(MAGIC) + 4 or head[: len(MAGIC)] != MAGIC:
            raise CryptError("crypt-damaged", "not an encrypted vault")
        (n,) = struct.unpack(">I", head[len(MAGIC):])
        if not n or n > 65536:
            raise CryptError("crypt-damaged", "header")
        try:
            header = json.loads(f.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise CryptError("crypt-damaged", "header") from exc
    if not isinstance(header, dict) or header.get("v") not in (1, 2) or not (header.get("wrap") or {}).get("key"):
        raise CryptError("crypt-damaged", "header")
    return header, len(MAGIC) + 4 + n, size


def _header_bytes(header: dict) -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return MAGIC + struct.pack(">I", len(h)) + h


def recover_file(blob: Path) -> None:
    """A full save stopped half-way: the file that was there is put back."""
    blob = Path(blob)
    old, tmp = Path(str(blob) + ".old"), Path(str(blob) + ".tmp")
    try:
        if not blob.exists() and old.exists():
            os.replace(old, blob)
        if tmp.exists():
            tmp.unlink()
    except OSError:
        pass


def _replace(tmp: Path, blob: Path) -> None:
    os.replace(tmp, blob)  # atomic: the old file stays until the new one is complete
    old = Path(str(blob) + ".old")
    if old.exists():
        try:
            old.unlink()
        except OSError:
            pass


def _aad(seg: int, piece: int, last: bool) -> bytes:
    return struct.pack(">IIB", seg, piece, 1 if last else 0)


def _iv(nonce: bytes, index: int) -> bytes:
    return nonce + struct.pack(">I", index)


def _record_head(kind: int, path: str, size: int, mtime: float) -> bytes:
    p = path.encode("utf-8")
    return struct.pack(">BH", kind, len(p)) + p + struct.pack(">Id", size, float(mtime or 0))


class _Segment:
    """Writes one segment to an open file."""

    def __init__(self, f, key: bytes, seg: int):
        self.f, self.aes, self.seg = f, AESGCM(key), seg
        self.nonce = os.urandom(8)
        self.index = 0
        self.buf = bytearray()
        f.write(SEG + self.nonce)

    def _piece(self, data: bytes, last: bool) -> None:
        enc = self.aes.encrypt(_iv(self.nonce, self.index), bytes(data), _aad(self.seg, self.index, last))
        self.f.write(struct.pack(">I", len(enc)) + enc)
        self.index += 1

    def push(self, data: bytes) -> None:
        self.buf += data
        while len(self.buf) >= 2 * PIECE:
            self._piece(self.buf[:PIECE], False)
            del self.buf[:PIECE]

    def file(self, path: str, data: bytes, mtime: float) -> None:
        self.push(_record_head(1, path, len(data), mtime))
        if data:
            self.push(data)

    def folder(self, path: str) -> None:
        self.push(_record_head(2, path, 0, 0))

    def remove(self, path: str) -> None:
        self.push(_record_head(3, path, 0, 0))

    def end(self) -> None:
        self.push(_record_head(0, "", 0, 0))
        while len(self.buf) > PIECE:
            self._piece(self.buf[:PIECE], False)
            del self.buf[:PIECE]
        self._piece(self.buf, True)
        self.buf = bytearray()


def _safe_rel(rel: str) -> bool:
    return bool(rel) and not any(x in ("", ".", "..") for x in rel.split("/")) and "\\" not in rel and "\x00" not in rel


@dataclass
class Replayed:
    segments: int
    torn: bool
    version: int


def _apply(targets: dict, kind: int, path: str, data: bytes, mtime: float) -> None:
    prefix, _, rel = path.partition("/")
    folder = targets.get(prefix)
    if folder is None or not _safe_rel(rel):
        raise CryptError("crypt-damaged", "path")
    target = Path(folder) / rel
    if kind == 2:
        target.mkdir(parents=True, exist_ok=True)
    elif kind == 1:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".skn-tmp-{os.getpid()}-{target.name}")
        tmp.write_bytes(data)
        os.replace(tmp, target)
        if mtime:
            ns = int(mtime) * 1_000_000
            os.utime(target, ns=(ns, ns))
    elif kind == 3:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target, ignore_errors=True)
        elif target.exists() or target.is_symlink():
            target.unlink()
    else:
        raise CryptError("crypt-damaged", "record")


class _Records:
    """Collects decrypted bytes and applies whole records."""

    def __init__(self, targets: dict):
        self.targets, self.buf, self.ended = targets, bytearray(), False

    def feed(self, plain: bytes) -> None:
        self.buf += plain
        while not self.ended and len(self.buf) >= 3:
            kind, plen = struct.unpack(">BH", self.buf[:3])
            if len(self.buf) < 15 + plen:
                return
            dlen, mtime = struct.unpack(">Id", self.buf[3 + plen: 15 + plen])
            if len(self.buf) < 15 + plen + dlen:
                return
            path = bytes(self.buf[3: 3 + plen]).decode("utf-8")
            data = bytes(self.buf[15 + plen: 15 + plen + dlen])
            del self.buf[: 15 + plen + dlen]
            if kind == 0:
                self.ended = True
                return
            _apply(self.targets, kind, path, data, mtime)


def replay(blob: Path, raw: bytes, targets: dict) -> Replayed:
    header, body_at, size = read_header(blob)
    aes = AESGCM(raw)
    with open(blob, "rb") as f:
        f.seek(body_at)
        if header["v"] == 1:
            return _replay_v1(f, aes, header, body_at, size, targets)
        at, seg = body_at, 0
        while at < size:
            if size - at < 12:
                return Replayed(seg, True, 2)
            head = f.read(12)
            if head[:4] != SEG:
                if seg == 0:
                    raise CryptError("crypt-damaged", "segment")
                return Replayed(seg, True, 2)
            nonce = head[4:12]
            at += 12
            rec = _Records(targets)
            index, done = 0, False
            while not done:
                if size - at < 4:
                    return Replayed(seg, True, 2)
                (n,) = struct.unpack(">I", f.read(4))
                if n > PIECE + 64 or at + 4 + n > size:
                    return Replayed(seg, True, 2)  # cut short
                if n < 16:
                    raise CryptError("crypt-damaged", f"piece {seg}.{index}")
                enc = f.read(n)
                plain = None
                for last in (False, True):
                    try:
                        plain = aes.decrypt(_iv(nonce, index), enc, _aad(seg, index, last))
                        done = last
                        break
                    except InvalidTag:
                        continue
                if plain is None:  # a whole piece that does not open: damage, or moved from elsewhere
                    raise CryptError("crypt-damaged", f"piece {seg}.{index}")
                rec.feed(plain)
                at += 4 + n
                index += 1
            if not rec.ended:
                raise CryptError("crypt-damaged", f"segment {seg}")
            seg += 1
        if seg == 0:
            raise CryptError("crypt-damaged", "empty")
        return Replayed(seg, False, 2)


def _replay_v1(f, aes, header, body_at, size, targets) -> Replayed:
    """Files in the first format: one stream of pieces, no segments."""
    nonce = _unb64((header.get("data") or {}).get("nonce"))
    rec = _Records(targets)
    at, index, saw_last = body_at, 0, False
    while at < size:
        lb = f.read(4)
        if len(lb) < 4:
            raise CryptError("crypt-damaged", "cut short")
        (n,) = struct.unpack(">I", lb)
        if n < 16 or n > PIECE + 64 or at + 4 + n > size:
            raise CryptError("crypt-damaged", "cut short")
        enc = f.read(n)
        last = at + 4 + n == size
        try:
            plain = aes.decrypt(_iv(nonce, index), enc, bytes([1 if last else 0]))
        except InvalidTag as exc:
            raise CryptError("crypt-damaged", f"piece {index}") from exc
        rec.feed(plain)
        at += 4 + n
        index += 1
        saw_last = last
    if not saw_last or not rec.ended:
        raise CryptError("crypt-damaged", "cut short")
    return Replayed(1, False, 1)


# ---------------------------------------------------------------- what the folders hold
@dataclass
class Scan:
    map: dict  # "v/rel" -> "d" | "size:mtime"
    key: str
    live: int


def scan_state(sources: dict) -> Scan:
    out: dict[str, str] = {}
    live = 0
    for prefix, folder in sources.items():
        root = Path(folder)
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
            rel_dir = "" if rel_dir == "." else rel_dir + "/"
            keep = []
            for d in sorted(dirnames):
                rel = rel_dir + d
                if os.path.islink(os.path.join(dirpath, d)) or _skipped(prefix, rel, True):
                    continue
                keep.append(d)
                out[f"{prefix}/{rel}"] = "d"
            dirnames[:] = keep
            for name in filenames:
                rel = rel_dir + name
                full = os.path.join(dirpath, name)
                if os.path.islink(full) or _skipped(prefix, rel, False):
                    continue
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                out[f"{prefix}/{rel}"] = f"{st.st_size}:{int(st.st_mtime_ns // 1_000_000)}"
                live += st.st_size
    text = "\n".join(f"{k}\x00{v}" for k, v in sorted(out.items()))
    key = _b64(hashlib.sha256(text.encode("utf-8")).digest())
    return Scan(out, key, live)


def _write_whole(blob: Path, raw: bytes, header: dict, sources: dict) -> Scan:
    state = scan_state(sources)
    tmp = Path(str(blob) + ".tmp")
    with open(tmp, "wb") as f:
        f.write(_header_bytes(header))
        seg = _Segment(f, raw, 0)
        for k, sig in state.map.items():
            if sig == "d":
                seg.folder(k)
        for k, sig in state.map.items():
            if sig == "d":
                continue
            prefix, _, rel = k.partition("/")
            try:
                data = (Path(sources[prefix]) / rel).read_bytes()
            except OSError:
                continue  # gone meanwhile
            seg.file(k, data, float(sig.split(":")[1]))
        seg.end()
        f.flush()
        os.fsync(f.fileno())
    _replace(tmp, blob)
    return state


# ---------------------------------------------------------------- an open vault
@dataclass
class Places:
    dir: Path
    work: Path
    data: Path
    state: Path


def places(private_root: Path, blob: Path) -> Places:
    d = Path(private_root) / "encrypted" / hashlib.sha1(str(blob).encode("utf-8")).hexdigest()[:20]
    return Places(d, d / "vault" / blob_name(blob), d / "data", d / "state.json")


def wipe(path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for p in [path, *path.parents]:
        if p.name == "encrypted":
            break
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass


class OpenVault:
    def __init__(self, blob: Path, raw: bytes, header: dict, where: Places):
        self.blob, self.raw, self.header, self.where = Path(blob), raw, header, where
        self.manifest: dict | None = None
        self.sealed_key: str | None = None
        self.segments = 0
        self.file_size = 0
        self.needs_whole = True
        self.torn = False
        self.conflicts: list[str] = []
        self.foreign: str | None = None
        self.before_seal = None  # called first (the desktop app checkpoints its SQLite history there)
        self._lock = threading.RLock()
        self._timer: threading.Timer | None = None

    @property
    def sources(self) -> dict:
        return {"v": self.where.work, "h": self.where.data / "history"}

    def changed(self) -> bool:
        return scan_state(self.sources).key != self.sealed_key

    def _remember(self, state: Scan) -> None:
        self.manifest = dict(state.map)
        self.sealed_key = state.key
        self.file_size = self.blob.stat().st_size if self.blob.exists() else 0
        _private_dir(self.where.dir)
        tmp = self.where.state.with_suffix(".tmp")
        tmp.write_text(json.dumps({"v": 2, "blob": str(self.blob), "sealed": state.key, "segments": self.segments,
                                   "size": self.file_size, "manifest": self.manifest}), encoding="utf-8")
        os.replace(tmp, self.where.state)

    def adopt(self, st: dict) -> None:
        self.sealed_key = st.get("sealed")
        self.segments = int(st.get("segments") or 0)
        self.file_size = int(st.get("size") or 0)
        self.manifest = dict(st["manifest"]) if st.get("manifest") else None
        self.needs_whole = not st.get("manifest") or not self.segments

    def _keep_foreign(self) -> None:
        """The file was replaced by another device's copy: that copy is kept beside."""
        if not self.blob.exists() or not self.file_size or self.blob.stat().st_size == self.file_size:
            return
        copy = beside_name(self.blob, "other version")
        os.replace(self.blob, copy)
        self.foreign = str(copy)
        self.needs_whole = True

    def seal(self, whole: bool = False) -> None:
        """Bring the file up to date: only what changed is added, unless it must be written whole."""
        with self._lock:
            if self.before_seal:
                try:
                    self.before_seal()
                except Exception:  # noqa: BLE001 - a checkpoint is a nicety
                    log.debug("before_seal failed", exc_info=True)
            cur = scan_state(self.sources)
            if not whole and not self.needs_whole and cur.key == self.sealed_key:
                return
            self._keep_foreign()
            bulky = self.file_size > 2 * cur.live + MB
            if whole or self.needs_whole or self.manifest is None or bulky:
                if self.header.get("v") != 2:
                    self.header = {**self.header, "v": 2, "data": {"cipher": "AES-256-GCM", "piece": PIECE, "form": "segments"}}
                    self.header["data"].pop("nonce", None)
                done = _write_whole(self.blob, self.raw, self.header, self.sources)
                self.segments = 1
                self.needs_whole = False
                self._remember(done)
            else:
                self._append(cur)

    def _append(self, cur: Scan) -> None:
        old = self.manifest or {}
        gone = [k for k in old if k not in cur.map or (old[k] == "d") != (cur.map[k] == "d")]
        removed = [k for k in gone if not any(g != k and old.get(g) == "d" and k.startswith(g + "/") for g in gone)]
        folders = [k for k, s in cur.map.items() if s == "d" and old.get(k) != "d"]
        files = [k for k, s in cur.map.items() if s != "d" and old.get(k) != s]
        with open(self.blob, "ab") as f:
            seg = _Segment(f, self.raw, self.segments)
            for k in removed:
                seg.remove(k)
            for k in folders:
                seg.folder(k)
            for k in files:
                prefix, _, rel = k.partition("/")
                try:
                    data = (Path(self.sources[prefix]) / rel).read_bytes()
                except OSError:
                    continue
                seg.file(k, data, float(cur.map[k].split(":")[1]))
            seg.end()
            f.flush()
            os.fsync(f.fileno())
        self.segments += 1
        self._remember(cur)

    def touch(self, delay: float = 8.0) -> None:
        """Something changed: the file is brought up to date shortly (changes in a row go in once)."""
        if self._timer:
            self._timer.cancel()
        self._timer = threading.Timer(delay, self._timed_seal)
        self._timer.daemon = True
        self._timer.start()

    def _timed_seal(self) -> None:
        try:
            self.seal()
        except Exception:  # noqa: BLE001
            log.exception("encrypted vault not saved")

    def cancel_timer(self) -> None:
        if self._timer:
            self._timer.cancel()
            self._timer = None


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _open_fresh(v: OpenVault) -> None:
    wipe(v.where.dir)
    _private_dir(v.where.work)
    r = replay(v.blob, v.raw, {"v": v.where.work, "h": v.where.data / "history"})
    v.segments = r.segments
    v.needs_whole = r.torn or r.version == 1
    v.torn = r.torn
    v._remember(scan_state(v.sources))
    if v.needs_whole:
        v.seal()


def _open_with_key(blob: Path, raw: bytes, header: dict, where: Places) -> OpenVault:
    v = OpenVault(blob, raw, header, where)
    left = _read_json(where.state)
    if left and left.get("blob") == str(blob) and where.work.is_dir():
        cur = scan_state(v.sources)
        if cur.key != left.get("sealed"):
            same_file = blob.exists() and blob.stat().st_size == int(left.get("size") or -1)
            if same_file and left.get("manifest"):
                v.adopt(left)
                v.seal()
                return v
            # the file changed elsewhere: it wins; unsaved notes of this device come back as copies
            before = left.get("manifest") or {}
            saved = []
            for k, sig in cur.map.items():
                if k.startswith("v/") and sig != "d" and before.get(k) != sig:
                    try:
                        saved.append((k[2:], (where.work / k[2:]).read_bytes()))
                    except OSError:
                        pass
            _open_fresh(v)
            for rel, data in saved:
                here = where.work / rel
                clash = here.exists()
                if clash:
                    try:
                        if here.read_bytes() == data:
                            continue
                    except OSError:
                        pass
                target = beside_name(here, "conflict") if clash else here
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                if clash:
                    v.conflicts.append(str(target.relative_to(where.work)).replace(os.sep, "/"))
            if saved:
                v.seal()
            return v
    _open_fresh(v)
    return v


def create_vault(blob: Path, password, where: Places) -> tuple[OpenVault, str]:
    """A new, empty encrypted vault, opened. → (vault, recovery code)."""
    blob = Path(blob)
    pw = check_password(password)
    if blob.exists():
        raise CryptError("already-exists", str(blob))
    raw = os.urandom(32)
    header, code = _new_header(blob_name(blob), raw, pw)
    wipe(where.dir)
    _private_dir(where.work)
    v = OpenVault(blob, raw, header, where)
    v.seal(True)
    return v, code


def _same_tree(a: Path, b: Path) -> bool:
    sa, sb = scan_state({"v": a}), scan_state({"v": b})
    if set(sa.map) != set(sb.map):
        return False
    for k, s in sa.map.items():
        t = sb.map[k]
        if (s == "d") != (t == "d"):
            return False
        if s != "d" and (s.split(":")[0] != t.split(":")[0] or (a / k[2:]).read_bytes() != (b / k[2:]).read_bytes()):
            return False
    return True


def encrypt_folder(folder: Path, history: Path | None, blob: Path, password, where: Places) -> tuple[OpenVault, str]:
    """An existing vault made into an encrypted file, opened again and compared with the
    folder before anything else happens. → (vault, recovery code)."""
    folder, blob = Path(folder), Path(blob)
    pw = check_password(password)
    if blob.exists():
        raise CryptError("already-exists", str(blob))
    raw = os.urandom(32)
    header, code = _new_header(blob_name(blob), raw, pw)
    sources = {"v": folder}
    if history:
        sources["h"] = history
    _write_whole(blob, raw, header, sources)
    v = OpenVault(blob, raw, header, where)
    try:
        _open_fresh(v)
        if not _same_tree(folder, where.work):
            raise CryptError("crypt-verify-failed")
    except Exception:
        wipe(where.dir)
        try:
            blob.unlink()
        except OSError:
            pass
        raise
    return v, code


def unlock_vault(blob: Path, password, where: Places) -> OpenVault:
    blob = Path(blob)
    recover_file(blob)
    header, _, _ = read_header(blob)
    raw = _unwrap_password(header, password)
    return _open_with_key(blob, raw, header, where)


def verify_password(blob: Path, password) -> bool:
    header, _, _ = read_header(Path(blob))
    _unwrap_password(header, password)
    return True


def _rewrite_header(blob: Path, change, open_vault: OpenVault | None) -> dict:
    blob = Path(blob)
    if open_vault:
        open_vault.seal()
    header, body_at, size = read_header(blob)
    fresh = change(header)
    tmp = Path(str(blob) + ".tmp")
    with open(blob, "rb") as src, open(tmp, "wb") as out:
        out.write(_header_bytes(fresh))
        src.seek(body_at)
        shutil.copyfileobj(src, out, 4 * MB)
        out.flush()
        os.fsync(out.fileno())
    _replace(tmp, blob)
    if open_vault:
        open_vault.header = fresh
        open_vault._remember(scan_state(open_vault.sources))
    return fresh


def change_password(blob: Path, old, new, open_vault: OpenVault | None = None) -> bool:
    pw = check_password(new)
    raw = _unwrap_password(read_header(Path(blob))[0], old)
    _rewrite_header(blob, lambda h: {**h, **_wrap_password(raw, pw)}, open_vault)
    return True


def recover_password(blob: Path, code, new, open_vault: OpenVault | None = None) -> bool:
    pw = check_password(new)
    raw = _unwrap_recovery(read_header(Path(blob))[0], code)
    _rewrite_header(blob, lambda h: {**h, **_wrap_password(raw, pw)}, open_vault)
    return True


def new_recovery_code(blob: Path, password, open_vault: OpenVault | None = None) -> str:
    raw = _unwrap_password(read_header(Path(blob))[0], password)
    code, rec = _wrap_recovery(raw)
    _rewrite_header(blob, lambda h: {**h, "recovery": rec}, open_vault)
    return code


def has_recovery(blob: Path) -> bool:
    try:
        return bool(read_header(Path(blob))[0].get("recovery"))
    except CryptError:
        return False


def decrypt_to(open_vault: OpenVault, target: Path) -> Path:
    """The open vault turned back into a normal folder `target` (which must not exist yet)."""
    target = Path(target)
    open_vault.seal()
    if target.exists():
        if any(target.iterdir()):
            raise CryptError("already-exists", str(target))
        target.rmdir()
    shutil.copytree(open_vault.where.work, target, symlinks=False)
    if not _same_tree(open_vault.where.work, target):
        wipe(target)
        raise CryptError("crypt-verify-failed")
    return target


def tidy(private_root: Path, keep: Path | None = None) -> None:
    """Empty the private folders of vaults that are not open, unless they hold changes that
    never reached their file (those are saved the next time that vault is opened)."""
    base = Path(private_root) / "encrypted"
    if not base.is_dir():
        return
    for d in base.iterdir():
        if keep and d == keep:
            continue
        st = _read_json(d / "state.json")
        unsaved = False
        if st and st.get("blob") and Path(st["blob"]).exists():
            work = d / "vault" / blob_name(st["blob"])
            try:
                unsaved = work.is_dir() and scan_state({"v": work, "h": d / "data" / "history"}).key != st.get("sealed")
            except OSError:
                unsaved = False
        if not unsaved:
            wipe(d)
