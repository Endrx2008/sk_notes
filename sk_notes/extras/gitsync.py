"""Keeping a vault in step with a Git repository (GitHub, GitLab, any Git server).

Same behaviour as sk_notes for Android (android/web/src/backend/git-sync.js), with the
`git` program of the computer and the vault's own ``.git`` folder: the vault stays a
normal repository that Git, the Git plugin of Obsidian, Foam or Tolaria work with.

One round of sync():
  1. ask the server where its branch is;
  2. commit what changed in the vault;
  3. if the server has commits this computer lacks: fetch them and merge;
  4. push (again from 1. if another device pushed in the meantime).

Merges never leave conflict markers in a note and never drop text:
  - a note changed on both sides in different places is merged line by line;
  - the same lines changed on both sides: the server's text stays, and this computer's
    is saved beside it as "Name (conflict <date>).md";
  - a note deleted on one side and changed on the other is kept;
  - settings files (names starting with "."): the server's version wins, no copies.

The password or token is given to git for that repository's address only, through the
environment (never written to .git/config, never on the command line).
"""

from __future__ import annotations

import base64
import logging
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

DEFAULT_IGNORE = "\n".join([
    "# Files that belong to one device only (written by sk_notes)",
    ".trash/",
    ".sk_notes/workspace.json",
    ".sk_notes/workspaces.json",
    ".sk_notes/workspace-mobile.json",
    ".sk_notes/workspaces-mobile.json",
    ".sk_notes/rename-journal.json",
    ".sk_notes/graph-positions.json",
    ".sk_notes/cache.db*",
    ".sk_notes/history.db*",
    ".sk_notes/embeddings.db*",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache",
    "",
])
# never committed from this computer and never overwritten on it, whatever .gitignore says
DEVICE_FILES = {".sk_notes/workspace.json", ".sk_notes/workspaces.json", ".sk_notes/rename-journal.json",
                ".sk_notes/graph-positions.json"}
MAX_FILE = 50 * 1024 * 1024
TEXT_MERGE = (".md", ".markdown", ".txt")
SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never",
        "-c", "core.quotePath=false", "-c", "credential.helper="]


class SyncError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code, self.detail = code, detail


def classify(stderr: str) -> SyncError:
    s = (stderr or "").lower()
    if any(x in s for x in ("authentication failed", "401", "403", "could not read username", "invalid username or password", "access denied", "http basic: access denied")):
        return SyncError("sync-auth", stderr.strip()[-300:])
    if "not found" in s or "does not appear to be a git repository" in s or "404" in s:
        return SyncError("sync-no-repo", stderr.strip()[-300:])
    if any(x in s for x in ("could not resolve host", "unable to access", "failed to connect", "network is unreachable", "timed out", "connection refused")):
        return SyncError("network-error", stderr.strip()[-300:])
    if "rejected" in s or "fetch first" in s or "non-fast-forward" in s:
        return SyncError("sync-rejected", stderr.strip()[-300:])
    return SyncError("sync-failed", stderr.strip()[-300:])


def conflict_name(path: str, stamp: str, taken) -> str:
    slash = path.rfind("/")
    d, name = path[: slash + 1], path[slash + 1:]
    dot = name.rfind(".")
    base, ext = (name[:dot], name[dot:]) if dot > 0 else (name, "")
    n = 1
    while True:
        c = f"{d}{base} (conflict {stamp}{' ' + str(n) if n > 1 else ''}){ext}"
        if not taken(c):
            return c
        n += 1


@dataclass
class Entry:
    mode: str
    type: str
    oid: str


@dataclass
class Result:
    committed: bool = False
    pulled: int = 0
    pushed: bool = False
    changed: list = field(default_factory=list)
    conflicts: list = field(default_factory=list)
    too_big: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"committed": self.committed, "pulled": self.pulled, "pushed": self.pushed, "changed": self.changed,
                "conflicts": self.conflicts, "tooBig": self.too_big, "unwritable": []}


class GitSync:
    def __init__(self, root: Path, url: str, branch: str = "main", author: tuple[str, str] = ("sk_notes", "sk_notes@localhost"),
                 auth: tuple[str, str] | None = None, before_overwrite=None, git_dir: Path | None = None,
                 upload_only: bool = False):
        self.root = Path(root)
        # SKAI_ Memory: the vault is not writable, so the repository lives elsewhere (git_dir) and
        # the files only go up (upload_only): what is on the server never overwrites the memory
        self.git_dir = Path(git_dir) if git_dir else self.root / ".git"
        self.upload_only = upload_only
        self.url, self.branch, self.author, self.auth = url, branch or "main", author, auth
        self.before_overwrite = before_overwrite  # (path, old bytes) before a note is replaced or removed

    # ------------------------------------------------------------- running git
    def _env(self, remote: bool) -> dict:
        env = dict(os.environ, GIT_DIR=str(self.git_dir), GIT_WORK_TREE=str(self.root), GIT_TERMINAL_PROMPT="0",
                   GIT_ASKPASS="/bin/false", SSH_ASKPASS="/bin/false", LC_ALL="C")
        env.pop("GIT_INDEX_FILE", None)
        if remote and self.auth:
            user, secret = self.auth
            token = base64.b64encode(f"{user or 'git'}:{secret}".encode("utf-8")).decode("ascii")
            env.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0=f"http.{self.url}.extraHeader",
                       GIT_CONFIG_VALUE_0=f"Authorization: Basic {token}")
        return env

    def git(self, *args, input: bytes | None = None, remote: bool = False, check: bool = True, env: dict | None = None,
            timeout: int = 300) -> subprocess.CompletedProcess:
        e = self._env(remote)
        if env:
            e.update(env)
        try:
            r = subprocess.run(["git", *SAFE, *args], cwd=self.root, env=e, input=input, capture_output=True, timeout=timeout, check=False)  # noqa: S603,S607
        except FileNotFoundError as exc:
            raise SyncError("git-missing") from exc
        except subprocess.TimeoutExpired as exc:
            raise SyncError("network-error", "timed out") from exc
        if check and r.returncode != 0:
            err = r.stderr.decode("utf-8", "replace")
            raise classify(err) if remote else SyncError("sync-failed", err.strip()[-300:])
        return r

    def out(self, *args, **kw) -> str:
        return self.git(*args, **kw).stdout.decode("utf-8", "replace").strip()

    def rev(self, ref: str) -> str | None:
        r = self.git("rev-parse", "--verify", "-q", ref + "^{commit}", check=False)
        return r.stdout.decode().strip() or None if r.returncode == 0 else None

    # ------------------------------------------------------------- set up
    def ensure(self) -> None:
        """A repository with the remote "origin" at our address (an existing .git is kept)."""
        gitdir = self.git_dir
        if gitdir.is_symlink() or (gitdir.exists() and not gitdir.is_dir()):
            raise SyncError("sync-failed", ".git is not a folder")
        if not gitdir.exists():
            gitdir.parent.mkdir(parents=True, exist_ok=True)
            self.git("init", "-q", "-b", self.branch)
        remotes = self.out("remote").split()
        if "origin" in remotes:
            self.git("remote", "set-url", "origin", self.url)
        else:
            self.git("remote", "add", "origin", self.url)
        if self.git_dir != self.root / ".git":
            # the vault cannot take a .gitignore: the same rules go in the repository itself
            ex = self.git_dir / "info" / "exclude"
            ex.parent.mkdir(parents=True, exist_ok=True)
            ex.write_text(DEFAULT_IGNORE + ".audit.log\n", encoding="utf-8")
            return
        gi = self.root / ".gitignore"
        if not gi.exists():
            gi.write_text(DEFAULT_IGNORE, encoding="utf-8")

    def remote_info(self) -> tuple[dict, str | None]:
        """({branch: oid}, default branch) of the server; also proves the address and sign-in."""
        text = self.out("ls-remote", "--symref", self.url, remote=True, timeout=60)
        branches, default = {}, None
        for line in text.splitlines():
            if line.startswith("ref: ") and line.endswith("\tHEAD"):
                ref = line[5:].split("\t")[0]
                if ref.startswith("refs/heads/"):
                    default = ref[11:]
                continue
            parts = line.split("\t")
            if len(parts) == 2 and parts[1].startswith("refs/heads/"):
                branches[parts[1][11:]] = parts[0]
        if not default or default not in branches:
            default = "main" if "main" in branches else "master" if "master" in branches else next(iter(branches), None)
        return branches, default

    # ------------------------------------------------------------- 2. commit
    def commit_local(self) -> tuple[bool, list]:
        too_big = []
        r = self.git("status", "--porcelain", "-z", "-uall")
        for item in r.stdout.decode("utf-8", "replace").split("\0"):
            if len(item) > 3 and item[:2] in ("??", " M", "M ", "MM", "A ", "AM"):
                p = item[3:]
                try:
                    if (self.root / p).stat().st_size > MAX_FILE:
                        too_big.append(p)
                except OSError:
                    pass
        self.git("add", "-A")
        # this computer's own files and files too large for hosting sites stay out of the commit
        keep_out = sorted(DEVICE_FILES | set(too_big))
        if self.rev("HEAD"):
            self.git("reset", "-q", "--", *keep_out, check=False)
        else:
            self.git("rm", "-q", "--cached", "--ignore-unmatch", "--", *keep_out, check=False)
        if self.git("diff", "--cached", "--quiet", check=False).returncode == 0:
            return False, too_big
        name, email = self.author
        msg = f"sk_notes (desktop): {time.strftime('%Y-%m-%d %H:%M')}\n"
        self.git("-c", f"user.name={name}", "-c", f"user.email={email}", "commit", "-q", "--no-verify", "-m", msg)
        return True, too_big

    # ------------------------------------------------------------- 3. merge
    def flat(self, ref: str | None) -> dict:
        if not ref:
            return {}
        r = self.git("ls-tree", "-r", "-z", "--full-tree", ref)
        out = {}
        for item in r.stdout.split(b"\0"):
            if not item:
                continue
            meta, path = item.split(b"\t", 1)
            mode, typ, oid = meta.decode().split(" ")
            out[path.decode("utf-8", "replace")] = Entry(mode, typ, oid)
        return out

    def blob(self, oid: str) -> bytes:
        return self.git("cat-file", "blob", oid).stdout

    def write_blob(self, data: bytes) -> str:
        return self.out("hash-object", "-w", "--stdin", input=data)

    def _merge_text(self, o: Entry, b: Entry, t: Entry) -> bytes | None:
        """Line-by-line merge; None when both sides changed the same lines (or not text)."""
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for name, e in (("ours", o), ("base", b), ("theirs", t)):
                data = self.blob(e.oid)
                if b"\0" in data:
                    return None
                p = Path(d) / name
                p.write_bytes(data)
                paths.append(str(p))
            r = subprocess.run(["git", "merge-file", "-p", "-q", *paths], capture_output=True, check=False)  # noqa: S603,S607
            return r.stdout if r.returncode == 0 else None

    def _merge_flat(self, ours: dict, base: dict, theirs: dict) -> tuple[dict, list]:
        result, conflicts = {}, []
        stamp = time.strftime("%Y-%m-%d %H.%M")
        same = lambda a, b: (a is None and b is None) or (a is not None and b is not None and a.oid == b.oid)  # noqa: E731
        taken = lambda p: p in ours or p in theirs or p in result  # noqa: E731
        for path in sorted(set(ours) | set(theirs) | set(base)):
            o, b, t = ours.get(path), base.get(path), theirs.get(path)
            if same(o, t):
                keep = o
            elif same(o, b):
                keep = t
            elif same(t, b):
                keep = o
            elif o is None:
                keep = t  # deleted here, changed there: the change is kept
            elif t is None:
                keep = o  # deleted there, changed here: the change is kept
            elif o.type != "blob" or t.type != "blob" or path.split("/")[-1].startswith(".") or path.startswith("."):
                keep = t  # settings: the server's version, no copies
            else:
                merged = self._merge_text(o, b, t) if b is not None and b.type == "blob" and path.lower().endswith(TEXT_MERGE) else None
                if merged is not None:
                    keep = Entry(o.mode, "blob", self.write_blob(merged))
                else:
                    keep = t
                    copy = conflict_name(path, stamp, taken)
                    result[copy] = o
                    conflicts.append({"path": path, "copy": copy})
            if keep is not None:
                result[path] = keep
        return result, conflicts

    def _write_tree(self, flat: dict) -> str:
        with tempfile.TemporaryDirectory() as d:
            env = {"GIT_INDEX_FILE": str(Path(d) / "index")}
            lines = b"".join(f"{e.mode} {e.oid}\t".encode() + p.encode("utf-8") + b"\0" for p, e in flat.items() if e.type == "blob")
            self.git("update-index", "-z", "--index-info", input=lines, env=env)
            return self.git("write-tree", env=env).stdout.decode().strip()

    def _disk(self, path: str) -> bytes | None:
        try:
            return (self.root / path).read_bytes()
        except OSError:
            return None

    def _apply(self, ours: dict, result: dict) -> tuple[list, list]:
        """Bring the files of the vault from `ours` to `result`. A note changed on disk while
        the sync ran is put aside first, never overwritten."""
        changed, late = [], []
        stamp = time.strftime("%Y-%m-%d %H.%M")
        for path in sorted(set(ours) | set(result)):
            o, r = ours.get(path), result.get(path)
            if (o and r and o.oid == r.oid) or (o is None and r is None) or path in DEVICE_FILES:
                continue
            if r is not None and r.type != "blob":
                continue
            cur = self._disk(path)
            cur_oid = self.out("hash-object", "--stdin", input=cur) if cur is not None else None
            target = self.root / path
            if r is not None:
                if cur_oid == r.oid:
                    changed.append(path)
                    continue
                if cur is not None and cur_oid != (o.oid if o else None) and not path.startswith("."):
                    copy = conflict_name(path, stamp, lambda c: c in ours or c in result or (self.root / c).exists())
                    (self.root / copy).parent.mkdir(parents=True, exist_ok=True)
                    (self.root / copy).write_bytes(cur)
                    late.append({"path": path, "copy": copy})
                elif cur is not None and self.before_overwrite:
                    self.before_overwrite(path, cur)
                target.parent.mkdir(parents=True, exist_ok=True)
                tmp = target.with_name(f".skn-tmp-{os.getpid()}-{target.name}")
                tmp.write_bytes(self.blob(r.oid))
                if r.mode == "100755":
                    os.chmod(tmp, 0o755)
                os.replace(tmp, target)
                changed.append(path)
            else:
                if cur is not None and o is not None and cur_oid == o.oid:
                    if self.before_overwrite:
                        self.before_overwrite(path, cur)
                    target.unlink()
                    parent = target.parent
                    while parent != self.root:
                        try:
                            parent.rmdir()
                        except OSError:
                            break
                        parent = parent.parent
                changed.append(path)
        return changed, late

    def merge(self, local: str | None, remote: str) -> tuple[list, list, bool]:
        base = self.out("merge-base", local, remote, check=False) if local else ""
        base = base or None
        ours, theirs, base_flat = self.flat(local), self.flat(remote), self.flat(base)
        result, conflicts = self._merge_flat(ours, base_flat, theirs)
        tree = self._write_tree(result)
        their_tree = self.out("rev-parse", f"{remote}^{{tree}}")
        head = remote
        if not (tree == their_tree and (not local or base == local)):
            name, email = self.author
            parents = ["-p", local, "-p", remote] if local else ["-p", remote]
            head = self.out("-c", f"user.name={name}", "-c", f"user.email={email}", "commit-tree", tree, *parents,
                            "-m", "Merge the changes of other devices (sk_notes desktop)")
        changed, late = self._apply(ours, result)
        # the branch and the index follow; the files are already in place
        self.git("update-ref", f"refs/heads/{self.branch}", head)
        self.git("symbolic-ref", "HEAD", f"refs/heads/{self.branch}")
        self.git("read-tree", head)
        return changed, conflicts + late, head != remote

    # ------------------------------------------------------------- the whole round
    def upload(self) -> dict:
        """Upload only (SKAI_ Memory): commit the files as they are and send them. When the server
        has commits this computer does not, they stay in the history (a merge keeping these files)
        but never change the files here."""
        self.ensure()
        out = Result()
        last_error = None
        for _attempt in range(3):
            branches, _default = self.remote_info()
            remote = branches.get(self.branch)
            committed, out.too_big = self.commit_local()
            out.committed = out.committed or committed
            local = self.rev("HEAD")
            if not local or local == remote:
                last_error = None
                break
            if remote:
                if self.git("cat-file", "-e", f"{remote}^{{commit}}", check=False).returncode != 0:
                    self.git("fetch", "-q", "--no-tags", self.url, f"+refs/heads/{self.branch}:refs/remotes/origin/{self.branch}", remote=True)
                if self.git("merge-base", "--is-ancestor", remote, local, check=False).returncode != 0:
                    name, email = self.author
                    tree = self.out("rev-parse", f"{local}^{{tree}}")
                    head = self.out("-c", f"user.name={name}", "-c", f"user.email={email}", "commit-tree", tree, "-p", local, "-p", remote,
                                    "-m", "SKAI_ Memory from this computer (the server's other changes stay in the history)")
                    self.git("update-ref", f"refs/heads/{self.branch}", head)
                    self.git("read-tree", head)
            try:
                self.git("push", "-q", self.url, f"HEAD:refs/heads/{self.branch}", remote=True)
                self.git("update-ref", f"refs/remotes/origin/{self.branch}", "HEAD", check=False)
                out.pushed = True
                last_error = None
                break
            except SyncError as exc:
                if exc.code != "sync-rejected":
                    raise
                last_error = exc
        if last_error:
            raise last_error
        return out.as_dict()

    def sync(self) -> dict:
        if self.upload_only:
            return self.upload()
        self.ensure()
        out = Result()
        last_error = None
        for _attempt in range(3):
            branches, _default = self.remote_info()
            remote = branches.get(self.branch)
            local = self.rev("HEAD")
            if remote and not local:
                # the first round: the repository's files come first, then what this vault has goes on top
                self.git("fetch", "-q", "--no-tags", self.url, f"+refs/heads/{self.branch}:refs/remotes/origin/{self.branch}", remote=True)
                ch, cf, _ = self.merge(None, remote)
                out.changed += ch
                out.conflicts += cf
            committed, out.too_big = self.commit_local()
            out.committed = out.committed or committed
            local = self.rev("HEAD")
            push = False
            if not remote:
                push = bool(local)
            elif remote != local:
                if self.git("cat-file", "-e", f"{remote}^{{commit}}", check=False).returncode != 0:
                    self.git("fetch", "-q", "--no-tags", self.url, f"+refs/heads/{self.branch}:refs/remotes/origin/{self.branch}", remote=True)
                ahead = local and self.git("merge-base", "--is-ancestor", remote, local, check=False).returncode == 0
                if ahead:
                    push = True
                else:
                    ch, cf, push = self.merge(local, remote)
                    out.changed += ch
                    out.conflicts += cf
            if not push:
                last_error = None
                break
            try:
                self.git("push", "-q", self.url, f"HEAD:refs/heads/{self.branch}", remote=True)
                self.git("update-ref", f"refs/remotes/origin/{self.branch}", "HEAD", check=False)
                out.pushed = True
                last_error = None
                break
            except SyncError as exc:
                if exc.code != "sync-rejected":
                    raise
                last_error = exc  # another device pushed meanwhile: take its commits and try again
        if last_error:
            raise last_error
        out.changed = sorted(set(out.changed))
        out.pulled = len(out.changed)
        return out.as_dict()
