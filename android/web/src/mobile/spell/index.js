// sk_notes for Android – the spell checker of sk_notes (downloaded languages, see routes-spell.js).
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { reloadSpell } from './checker.js';
import { spellExtension } from './editor.js';
import { renderSpellChoice, renderSpellSettings } from './settings.js';

export function installSpell(app) {
  app.renderSpellSettings = (el) => renderSpellSettings(app, el);
  app.renderSpellChoice = (el, modal) => renderSpellChoice(app, el, modal);
  app.editorExtensions.push(spellExtension);
  app.updateEditorExtensions();
  reloadSpell().catch((e) => console.warn('spell checker', e));
}
