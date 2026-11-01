// Column labels of a base (kept apart from the view so it can be tested without a DOM).

import { t } from '../core/i18n.js';

export function propLabel(cfg, id) {
  // `properties` may name a note property with or without its "note." prefix (A-20)
  const props = cfg.properties || {};
  const dn = props[id]?.displayName || (id.startsWith('note.') ? props[id.slice(5)]?.displayName : props[`note.${id}`]?.displayName);
  if (dn) return dn;
  if (id.startsWith('note.')) return id.slice(5);
  if (id.startsWith('formula.')) return id.slice(8);
  if (id.startsWith('file.')) return { 'file.name': t('bases.file-name'), 'file.path': t('bases.file-path'), 'file.ext': t('bases.file-ext'), 'file.size': t('bases.file-size'),
    'file.ctime': t('bases.file-ctime'), 'file.mtime': t('bases.file-mtime'), 'file.tags': t('bases.file-tags'), 'file.folder': t('bases.file-folder'),
    'file.links': t('bases.file-links'), 'file.backlinks': t('bases.file-backlinks') }[id] || id;
  return id;
}
