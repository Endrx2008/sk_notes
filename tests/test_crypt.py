"""Encrypted vaults (sk_notes/core/crypt.py), and that the phone and the PC read each other's files."""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from sk_notes.core import crypt

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "tests" / "helpers" / "js_crypt.mjs"
V1 = ROOT / "android" / "web" / "tests" / "fixtures" / "v1.skvault"
HAS_NODE = shutil.which("node") is not None and HELPER.exists() and (ROOT / "android").is_dir()


def tree(d: Path) -> dict:
    out = {}
    for p in sorted(d.rglob("*")):
        rel = str(p.relative_to(d))
        out[rel + ("/" if p.is_dir() else "")] = "" if p.is_dir() else base64.b64encode(p.read_bytes()).decode()
    return out


class CryptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.n = 0

    def tearDown(self):
        self.tmp.cleanup()

    def where(self, blob):
        self.n += 1
        return crypt.places(self.dir / f"private{self.n}", blob)

    def put(self, root: Path, rel: str, data) -> None:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data if isinstance(data, bytes) else data.encode())

    def test_round_trip_and_wrong_password(self):
        blob = self.dir / "Diario.skvault"
        a, code = crypt.create_vault(blob, "correct horse", self.where(blob))
        self.assertRegex(code, r"^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$")
        self.put(a.where.work, "Nota.md", "# Nota\n\ntiramisù 🍰\n")
        self.put(a.where.work, "Cartella/Altra.md", "x" * 10)
        self.put(a.where.work, "big.bin", os.urandom(int(2.5 * 1024 * 1024)))
        (a.where.work / "Vuota").mkdir()
        self.put(a.where.work, ".sk_notes/cache.db", "cache, not kept")
        self.put(a.where.work, ".sk_notes/history.db", "kept")
        self.put(a.where.work, ".trash/x.md", "stays out")
        a.seal()
        self.assertFalse(a.changed())
        data = blob.read_bytes()
        for secret in (b"tiramis", b"Nota.md", b"Cartella"):
            self.assertNotIn(secret, data)
        b = crypt.unlock_vault(blob, "correct horse", self.where(blob))
        want = tree(a.where.work)
        for k in [".trash/", ".trash/x.md", ".sk_notes/cache.db"]:
            want.pop(k)
        self.assertEqual(tree(b.where.work), want)
        with self.assertRaises(crypt.CryptError) as cm:
            crypt.unlock_vault(blob, "correct hors", self.where(blob))
        self.assertEqual(cm.exception.code, "wrong-password")
        with self.assertRaises(crypt.CryptError) as cm:
            crypt.create_vault(self.dir / "x.skvault", "short", self.where(blob))
        self.assertEqual(cm.exception.code, "password-short")

    def test_incremental_saves_compaction_and_cut_short(self):
        blob = self.dir / "P.skvault"
        a, _ = crypt.create_vault(blob, "password-1", self.where(blob))
        self.put(a.where.work, "foto.bin", b"\x09" * int(1.5 * 1024 * 1024))
        for i in range(20):
            self.put(a.where.work, f"Note/N{i}.md", f"nota {i}\n")
        a.seal()
        base, saves = blob.stat().st_size, a.segments
        self.put(a.where.work, "Note/N3.md", "nota 3, cambiata\n")
        a.seal()
        self.assertLess(blob.stat().st_size - base, 400)
        self.assertEqual(a.segments, saves + 1)
        (a.where.work / "Note" / "N5.md").unlink()
        (a.where.work / "Note").rename(a.where.work / "Appunti")
        (a.where.work / "foto.bin").unlink()
        a.seal()
        self.assertEqual(a.segments, 1, "compacted once old versions take more room than the vault")
        self.assertEqual(tree(crypt.unlock_vault(blob, "password-1", self.where(blob)).where.work), tree(a.where.work))
        self.put(a.where.work, "Seconda.md", "second")
        a.seal()
        two = blob.stat().st_size
        self.put(a.where.work, "Terza.md", "third, cut short")
        a.seal()
        with open(blob, "r+b") as f:
            f.truncate(two + 20)
        c = crypt.unlock_vault(blob, "password-1", self.where(blob))
        self.assertTrue(c.torn)
        self.assertTrue((c.where.work / "Seconda.md").exists())
        self.assertFalse((c.where.work / "Terza.md").exists())
        self.assertFalse(crypt.unlock_vault(blob, "password-1", self.where(blob)).torn, "repaired")
        good = bytearray(blob.read_bytes())
        _, body_at, _ = crypt.read_header(blob)
        good[body_at + 40] ^= 1
        blob.write_bytes(bytes(good))
        with self.assertRaises(crypt.CryptError) as cm:
            crypt.unlock_vault(blob, "password-1", self.where(blob))
        self.assertEqual(cm.exception.code, "crypt-damaged")

    def test_password_change_recovery_code(self):
        blob = self.dir / "C.skvault"
        a, code = crypt.create_vault(blob, "old password", self.where(blob))
        self.put(a.where.work, "N.md", "changed, not saved yet")
        crypt.change_password(blob, "old password", "new password", a)
        self.assertEqual((crypt.unlock_vault(blob, "new password", self.where(blob)).where.work / "N.md").read_text(), "changed, not saved yet")
        for bad in (lambda: crypt.change_password(blob, "nope-nope", "x" * 9), lambda: crypt.recover_password(blob, "AAAA-BBBB", "x" * 9)):
            with self.assertRaises(crypt.CryptError):
                bad()
        crypt.recover_password(blob, " " + code.lower().replace("-", " ") + " ", "third password")
        crypt.verify_password(blob, "third password")
        code2 = crypt.new_recovery_code(blob, "third password")
        with self.assertRaises(crypt.CryptError) as cm:
            crypt.recover_password(blob, code, "fourth password")
        self.assertEqual(cm.exception.code, "wrong-code")
        crypt.recover_password(blob, code2, "fourth password")
        crypt.unlock_vault(blob, "fourth password", self.where(blob))

    def test_encrypt_existing_and_back(self):
        folder = self.dir / "Normale"
        self.put(folder, "Uno.md", "# Uno\n")
        self.put(folder, "Sub/Due.md", "# Due\n")
        self.put(folder, ".git/HEAD", "ref")
        blob = self.dir / "Normale.skvault"
        v, code = crypt.encrypt_folder(folder, None, blob, "cifra-adesso", self.where(blob))
        self.assertTrue(code)
        self.assertEqual((v.where.work / "Sub/Due.md").read_text(), "# Due\n")
        self.assertFalse((v.where.work / ".git").exists())
        self.put(v.where.work, "Nuova.md", "scritta")
        back = self.dir / "Di nuovo"
        crypt.decrypt_to(v, back)
        self.assertEqual((back / "Nuova.md").read_text(), "scritta")

    def test_unsaved_changes_and_replaced_file(self):
        blob = self.dir / "S.skvault"
        w = crypt.places(self.dir / "fixed", blob)
        a, _ = crypt.create_vault(blob, "password-1", w)
        self.put(a.where.work, "N.md", "saved")
        a.seal()
        self.put(a.where.work, "N.md", "typed, then killed")
        crypt.tidy(self.dir / "fixed")
        self.assertTrue((w.work / "N.md").exists(), "unsaved changes are kept")
        b = crypt.unlock_vault(blob, "password-1", w)
        self.assertEqual((b.where.work / "N.md").read_text(), "typed, then killed")
        c = crypt.unlock_vault(blob, "password-1", self.where(blob))
        d_where = crypt.places(self.dir / "devd", blob)
        d = crypt.unlock_vault(blob, "password-1", d_where)
        self.put(c.where.work, "N.md", "from c")
        c.seal(True)
        self.put(d.where.work, "N.md", "from d, not saved")
        e = crypt.unlock_vault(blob, "password-1", d_where)
        self.assertEqual((e.where.work / "N.md").read_text(), "from c")
        self.assertEqual(len(e.conflicts), 1)
        self.assertEqual((e.where.work / e.conflicts[0]).read_text(), "from d, not saved")
        crypt.tidy(self.dir / "fixed")
        self.assertFalse(w.dir.exists())

    @unittest.skipUnless(V1.exists(), "Android fixture not available")
    def test_android_1_2_0_file(self):
        blob = self.dir / "Vecchio.skvault"
        shutil.copy(V1, blob)
        v = crypt.unlock_vault(blob, "versione-uno", self.where(blob))
        self.assertEqual((v.where.work / "Nota.md").read_text(), "# Nota\n\nfatta con la 1.2.0\n")
        self.assertEqual((v.where.data / "history" / "k" / "1.json").read_text(), '{"h":1}')
        self.assertEqual(crypt.read_header(blob)[0]["v"], 2)
        crypt.unlock_vault(blob, "versione-uno", self.where(blob))

    @unittest.skipUnless(HAS_NODE, "node or the Android sources not available")
    def test_phone_and_pc_read_each_other(self):
        # made on the phone, opened here
        src = self.dir / "phone-src"
        self.put(src, "Dal telefono.md", "# Dal telefono\n")
        self.put(src, "Cartella/foto.bin", os.urandom(3 * 1024 * 1024))
        blob = self.dir / "Condiviso.skvault"
        code = subprocess.run(["node", str(HELPER), "create", str(blob), "password-comune", str(src)], check=True, capture_output=True, text=True).stdout.strip()
        v = crypt.unlock_vault(blob, "password-comune", self.where(blob))
        self.assertEqual(tree(v.where.work), tree(src))
        # changed here (an added save), opened on the phone
        self.put(v.where.work, "Dal PC.md", "# Dal PC\n")
        v.seal()
        out = json.loads(subprocess.run(["node", str(HELPER), "open", str(blob), "password-comune", str(self.dir / "js1")], check=True, capture_output=True, text=True).stdout)
        self.assertEqual(base64.b64decode(out["files"]["Dal PC.md"]).decode(), "# Dal PC\n")
        self.assertIn("Cartella/foto.bin", out["files"])
        # the phone adds a save; the recovery code made on the phone works here
        subprocess.run(["node", str(HELPER), "add", str(blob), "password-comune", str(self.dir / "js2"), "Ancora telefono.md", "ancora"], check=True, capture_output=True)
        w = crypt.unlock_vault(blob, "password-comune", self.where(blob))
        self.assertEqual((w.where.work / "Ancora telefono.md").read_text(), "ancora")
        crypt.recover_password(blob, code, "nuova-comune")
        out = json.loads(subprocess.run(["node", str(HELPER), "open", str(blob), "nuova-comune", str(self.dir / "js3")], check=True, capture_output=True, text=True).stdout)
        self.assertIn("Dal PC.md", out["files"])
        # made here, opened on the phone
        blob2 = self.dir / "DalPC.skvault"
        p, _ = crypt.create_vault(blob2, "password-pc!", self.where(blob2))
        self.put(p.where.work, "Nota.md", "creata sul PC")
        p.seal()
        out = json.loads(subprocess.run(["node", str(HELPER), "open", str(blob2), "password-pc!", str(self.dir / "js4")], check=True, capture_output=True, text=True).stdout)
        self.assertEqual(base64.b64decode(out["files"]["Nota.md"]).decode(), "creata sul PC")


if __name__ == "__main__":
    unittest.main()
