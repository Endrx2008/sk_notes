"""Every language file has the same keys as English and keeps the same placeholders."""

from __future__ import annotations

import json
import re
import unittest

from sk_notes.core import i18n

PLACEHOLDER = re.compile(r"\{\{?[A-Za-z_]+\}?\}")
EXPECTED = {"en", "it", "es", "fr", "de", "pt", "ru", "zh-CN", "ja"}


def keys(data: dict) -> set[str]:
    return {k for k in data if k != "_meta"}


class LocaleFiles(unittest.TestCase):
    def setUp(self):
        self.base = i18n.load(i18n.BASE)

    def test_all_languages_present(self):
        codes = {item["code"] for item in i18n.available()}
        self.assertEqual(codes, EXPECTED)

    def test_files_are_valid_json_with_meta(self):
        for f in i18n.LOCALES_DIR.glob("*.json"):
            data = json.loads(f.read_text(encoding="utf-8"))
            self.assertIn("name", data.get("_meta", {}), f.name)

    def test_translations_are_marked_for_review(self):
        for item in i18n.available():
            if item["code"] != i18n.BASE:
                self.assertTrue(item["review"], item["code"])

    def test_same_keys_as_english(self):
        for item in i18n.available():
            data = i18n.load(item["code"])
            self.assertEqual(keys(data) - keys(self.base), set(), f"{item['code']}: unknown keys")
            self.assertEqual(keys(self.base) - keys(data), set(), f"{item['code']}: missing keys")

    def test_placeholders_match(self):
        for item in i18n.available():
            data = i18n.load(item["code"])
            for key in keys(self.base):
                if key not in data:
                    continue
                want = sorted(PLACEHOLDER.findall(self.base[key]))
                got = sorted(PLACEHOLDER.findall(data[key]))
                self.assertEqual(got, want, f"{item['code']} {key}")

    def test_every_key_used_in_the_ui_exists_in_english(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("i18n_keys", i18n.LOCALES_DIR.parent.parent / "tools" / "i18n_keys.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertEqual(sorted(k for k in mod.used_keys() if k not in self.base), [])

    def test_no_empty_strings(self):
        for item in i18n.available():
            for key, text in i18n.load(item["code"]).items():
                if key != "_meta":
                    self.assertTrue(str(text).strip(), f"{item['code']} {key}")

    def test_system_language_mapping(self):
        import os
        from unittest import mock
        for env, want in (("it_IT.UTF-8", "it"), ("zh_CN.UTF-8", "zh-CN"), ("pt_BR.UTF-8", "pt"), ("C", "en"), ("xx_YY", "en")):
            with mock.patch.dict(os.environ, {"LANGUAGE": "", "LC_ALL": "", "LC_MESSAGES": "", "LANG": env}), \
                    mock.patch("locale.getlocale", return_value=(None, None)):
                self.assertEqual(i18n.system_language(), want, env)


if __name__ == "__main__":
    unittest.main()
