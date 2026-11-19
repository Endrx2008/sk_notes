// sk_notes for Android – `Buffer` for the Git library.
// Copyright (C) 2026 Enrico Miot
// SPDX-License-Identifier: GPL-3.0-or-later
//
// isomorphic-git expects Node's Buffer. The build gives it this one (the "buffer" package)
// instead of whatever `window.Buffer` is: the page has a small Buffer of its own for
// community plugins, which is not complete and which a plugin could replace.
export { Buffer } from 'buffer';
