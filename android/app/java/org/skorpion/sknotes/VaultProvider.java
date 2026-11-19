// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;

import java.io.File;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Hands single files to other apps ("open in default app", "share"), read-only.
 *
 * The provider is not exported: another app reaches a file only through the one address
 * sk_notes gave it together with a read grant (content://…files/f/<path, base64>/<name>).
 * The app's private storage is never handed out.
 */
public final class VaultProvider extends ContentProvider {
    static final String AUTHORITY = "org.skorpion.sknotes.files";

    static Uri uriFor(File f) {
        String token = Base64.encodeToString(f.getPath().getBytes(StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath("f").appendPath(token).appendPath(f.getName()).build();
    }

    private File fileOf(Uri uri) throws FileNotFoundException {
        List<String> parts = uri.getPathSegments();
        if (parts.size() != 3 || !"f".equals(parts.get(0))) throw new FileNotFoundException(String.valueOf(uri));
        File f;
        try {
            String path = new String(Base64.decode(parts.get(1), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8);
            f = new File(path).getCanonicalFile();
            File own = getContext().getFilesDir().getParentFile().getCanonicalFile(); // /data/data/<package>
            File cache = getContext().getCacheDir().getCanonicalFile();
            boolean inCache = f.getPath().startsWith(cache.getPath() + File.separator);
            if (f.getPath().startsWith(own.getPath() + File.separator) && !inCache) throw new FileNotFoundException("private");
        } catch (java.io.IOException | RuntimeException e) {
            throw new FileNotFoundException(String.valueOf(uri));
        }
        if (!f.isFile()) throw new FileNotFoundException(String.valueOf(uri));
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File f;
        try {
            f = fileOf(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null ? projection : new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        MatrixCursor c = new MatrixCursor(cols, 1);
        c.addRow(row);
        return c;
    }

    @Override
    public String getType(Uri uri) {
        try {
            return Mime.of(fileOf(uri).getName());
        } catch (FileNotFoundException e) {
            return null;
        }
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("read-only");
        return ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException("read-only");
    }
}
