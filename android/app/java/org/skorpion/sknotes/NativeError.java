// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

/** A failure with a code the page understands (ENOENT, EACCES, network-error…). */
final class NativeError extends Exception {
    final String code;
    final String detail;

    NativeError(String code, String detail) {
        super(code + (detail == null || detail.isEmpty() ? "" : ": " + detail));
        this.code = code;
        this.detail = detail == null ? "" : detail;
    }

    NativeError(String code) {
        this(code, "");
    }
}
