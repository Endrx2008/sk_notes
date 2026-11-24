// sk_notes for Android – the trash, seen from the page (the wheel menu opens it).
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later

import { route } from './router.js';
import { svc } from './state.js';
import { ApiError } from './util.js';
import { KEEP_MS, listTrash, purgeTrash, restoreFromTrash } from './trash.js';

const own = (ctx) => { if (ctx.plugin) throw new ApiError('permission-denied'); }; // the user's own choice only

export function registerTrash() {
  route('trash.list', (p, ctx) => { own(ctx); return { items: listTrash(svc().vault), keep: KEEP_MS }; });
  route('trash.restore', async (p, ctx) => {
    own(ctx);
    const s = svc();
    const path = restoreFromTrash(s.vault, p.name);
    await s.index.sync();
    s.emit('refresh', s.index.snapshot());
    return { path };
  });
  route('trash.delete', (p, ctx) => { own(ctx); return purgeTrash(svc().vault, p.name); });
  route('trash.empty', (p, ctx) => { own(ctx); return purgeTrash(svc().vault, null); });
}
