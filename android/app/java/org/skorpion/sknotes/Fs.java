// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.os.Process;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AccessDeniedException;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.NotDirectoryException;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Random;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** The file calls of the bridge (fs.*, hash). Paths are absolute; errors carry errno-like codes. */
final class Fs {
    private static final int MAX_DEPTH = 64;
    private static final Random RANDOM = new Random();

    private Fs() {
    }

    // ------------------------------------------------------------------ errors
    static NativeError error(Throwable e, String path) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof NativeError) return (NativeError) t;
            if (t instanceof ErrnoException) {
                int n = ((ErrnoException) t).errno;
                if (n == OsConstants.ENOENT) return new NativeError("ENOENT", path);
                if (n == OsConstants.EEXIST || n == OsConstants.ENOTEMPTY) return new NativeError("EEXIST", path);
                if (n == OsConstants.EACCES || n == OsConstants.EPERM || n == OsConstants.EROFS) return new NativeError("EACCES", path);
                if (n == OsConstants.EISDIR) return new NativeError("EISDIR", path);
                if (n == OsConstants.ENOTDIR) return new NativeError("ENOTDIR", path);
                if (n == OsConstants.ENOSPC || n == OsConstants.EDQUOT) return new NativeError("ENOSPC", path);
            }
            if (t instanceof NoSuchFileException) return new NativeError("ENOENT", path);
            if (t instanceof FileAlreadyExistsException || t instanceof DirectoryNotEmptyException) return new NativeError("EEXIST", path);
            if (t instanceof AccessDeniedException) return new NativeError("EACCES", path);
            if (t instanceof NotDirectoryException) return new NativeError("ENOTDIR", path);
            if (t == t.getCause()) break;
        }
        if (e instanceof FileNotFoundException) {
            File f = new File(path);
            if (!f.exists()) return new NativeError("ENOENT", path);
            if (f.isDirectory()) return new NativeError("EISDIR", path);
            return new NativeError("EACCES", path);
        }
        String msg = String.valueOf(e.getMessage());
        if (msg.contains("ENOSPC")) return new NativeError("ENOSPC", path);
        if (msg.contains("EACCES") || msg.contains("EPERM") || msg.contains("EROFS")) return new NativeError("EACCES", path);
        return new NativeError("EIO", path + ": " + msg);
    }

    static String path(JSONObject p, String key) throws NativeError {
        String s = p.optString(key, "");
        if (s.isEmpty() || s.charAt(0) != '/' || s.indexOf('\u0000') >= 0) throw new NativeError("EINVAL", s);
        return s;
    }

    // ------------------------------------------------------------------ reading
    private static BasicFileAttributes attrs(File f) {
        try {
            return Files.readAttributes(f.toPath(), BasicFileAttributes.class);
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /** {type, size, mtime, ctime, writable} or null when nothing is there. */
    static Object stat(String p) throws JSONException {
        File f = new File(p);
        BasicFileAttributes a = attrs(f);
        if (a == null) return JSONObject.NULL;
        long mtime = a.lastModifiedTime().toMillis();
        JSONObject o = new JSONObject();
        if (a.isDirectory()) return o.put("type", "dir").put("size", 0).put("mtime", mtime).put("ctime", mtime).put("writable", true);
        long born = a.creationTime().toMillis();
        return o.put("type", "file").put("size", a.size()).put("mtime", mtime).put("ctime", born > 0 && born < mtime ? born : mtime).put("writable", f.canWrite());
    }

    static JSONArray list(String p) throws NativeError, JSONException {
        File dir = new File(p);
        String[] names = dir.list();
        if (names == null) {
            if (!dir.exists()) throw new NativeError("ENOENT", p);
            if (!dir.isDirectory()) throw new NativeError("ENOTDIR", p);
            throw new NativeError("EACCES", p);
        }
        JSONArray out = new JSONArray();
        for (String name : names) {
            BasicFileAttributes a = attrs(new File(dir, name));
            boolean isDir = a != null && a.isDirectory();
            out.put(new JSONObject().put("name", name).put("type", isDir ? "dir" : "file")
                    .put("size", a == null || isDir ? 0 : a.size()).put("mtime", a == null ? 0 : a.lastModifiedTime().toMillis()));
        }
        return out;
    }

    /** Every file and folder under a folder: [[path, isDir, size, mtime, ctime], …], parents first. */
    static Bridge.Raw scan(String root, JSONArray ignore, boolean skipHidden) {
        Set<String> skip = new HashSet<>();
        for (int i = 0; ignore != null && i < ignore.length(); i++) skip.add(ignore.optString(i));
        StringBuilder sb = new StringBuilder(1 << 16);
        sb.append('[');
        walk(new File(root), "", skip, skipHidden, sb, 0);
        sb.append(']');
        return new Bridge.Raw(sb.toString());
    }

    private static void walk(File dir, String rel, Set<String> skip, boolean skipHidden, StringBuilder sb, int depth) {
        String[] names = dir.list();
        if (names == null || depth > MAX_DEPTH) return;
        for (String name : names) {
            if ((skipHidden && name.startsWith(".")) || skip.contains(name)) continue;
            File f = new File(dir, name);
            BasicFileAttributes a = attrs(f);
            if (a == null) continue;
            String r = rel.isEmpty() ? name : rel + "/" + name;
            if (sb.length() > 1) sb.append(',');
            sb.append('[').append(JSONObject.quote(r));
            if (a.isDirectory()) {
                sb.append(",true,0,0,0]");
                walk(f, r, skip, skipHidden, sb, depth + 1);
            } else {
                long mtime = a.lastModifiedTime().toMillis();
                long born = a.creationTime().toMillis();
                sb.append(",false,").append(a.size()).append(',').append(mtime).append(',').append(born > 0 && born < mtime ? born : mtime).append(']');
            }
        }
    }

    static byte[] readBytes(String p, int max) throws NativeError {
        File f = new File(p);
        try (FileInputStream in = new FileInputStream(f)) {
            long size = f.length();
            if (size > Integer.MAX_VALUE - 16) throw new NativeError("EFBIG", p);
            int want = max > 0 && size > max ? max : (int) size;
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(want, 256));
            byte[] buf = new byte[1 << 16];
            int left = max > 0 ? max : Integer.MAX_VALUE;
            int n;
            while (left > 0 && (n = in.read(buf, 0, Math.min(buf.length, left))) > 0) {
                out.write(buf, 0, n);
                left -= n;
            }
            return out.toByteArray();
        } catch (IOException e) {
            throw error(e, p);
        } catch (OutOfMemoryError e) {
            throw new NativeError("EFBIG", p);
        }
    }

    /** UTF-8 text, and whether the bytes really were UTF-8. */
    private static String decode(byte[] data, boolean[] strict) {
        try {
            String s = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data)).toString();
            if (strict != null) strict[0] = true;
            return s;
        } catch (CharacterCodingException e) {
            if (strict != null) strict[0] = false;
            return new String(data, StandardCharsets.UTF_8);
        }
    }

    static JSONObject readText(String p, int max) throws NativeError, JSONException {
        byte[] data = readBytes(p, max);
        boolean[] strict = new boolean[1];
        String text = decode(data, strict);
        File f = new File(p);
        return new JSONObject().put("text", text).put("utf8", strict[0]).put("writable", f.canWrite()).put("mtime", f.lastModified()).put("size", f.length());
    }

    static JSONArray readTexts(JSONArray paths) {
        JSONArray out = new JSONArray();
        for (int i = 0; paths != null && i < paths.length(); i++) {
            Object text = JSONObject.NULL;
            try {
                text = decode(readBytes(paths.optString(i), 0), null);
            } catch (NativeError e) {
                // a file that went away: null in its place
            }
            out.put(text);
        }
        return out;
    }

    static String readB64(String p) throws NativeError {
        try {
            return Base64.encodeToString(readBytes(p, 0), Base64.NO_WRAP);
        } catch (OutOfMemoryError e) {
            throw new NativeError("EFBIG", p);
        }
    }

    /** `length` bytes of a file from `offset`, as base64 (fewer at the end of the file). */
    static String readRange(String p, long offset, int length) throws NativeError {
        if (offset < 0 || length < 0 || length > (64 << 20)) throw new NativeError("EINVAL", "range");
        try (java.io.RandomAccessFile in = new java.io.RandomAccessFile(p, "r")) {
            in.seek(offset);
            byte[] buf = new byte[length];
            int got = 0;
            while (got < length) {
                int n = in.read(buf, got, length - got);
                if (n <= 0) break;
                got += n;
            }
            return Base64.encodeToString(buf, 0, got, Base64.NO_WRAP);
        } catch (IOException e) {
            throw error(e, p);
        } catch (OutOfMemoryError e) {
            throw new NativeError("EFBIG", p);
        }
    }

    static byte[] unB64(String b64) throws NativeError {
        try {
            return Base64.decode(b64 == null ? "" : b64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            throw new NativeError("EINVAL", "base64");
        }
    }

    // ------------------------------------------------------------------ writing
    static void mkdirs(String p) throws NativeError {
        File d = new File(p);
        if (d.isDirectory()) return;
        if (d.exists()) throw new NativeError("EEXIST", p);
        if (!d.mkdirs() && !d.isDirectory()) throw new NativeError("EACCES", p);
    }

    /** Write through a temporary file in the same folder, so a crash never leaves half a note. */
    static void writeAtomic(String p, byte[] data, long mtime) throws NativeError {
        File f = new File(p);
        File dir = f.getParentFile();
        if (dir != null) mkdirs(dir.getPath());
        if (f.isDirectory()) throw new NativeError("EISDIR", p);
        if (f.exists() && !f.canWrite()) throw new NativeError("EACCES", p);
        File tmp = new File(dir, ".skn-tmp-" + Process.myPid() + "-" + RANDOM.nextInt(1000000));
        try {
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(data);
                try {
                    out.getFD().sync();
                } catch (IOException e) {
                    // some shared-storage layers refuse fsync: the data is written all the same
                }
            }
            Os.rename(tmp.getPath(), f.getPath());
        } catch (IOException | ErrnoException e) {
            tmp.delete();
            NativeError err = error(e, p);
            // a folder that takes no new files but holds a writable one: write in place
            if (!"EACCES".equals(err.code) || !f.isFile() || !f.canWrite()) throw err;
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(data);
            } catch (IOException e2) {
                throw error(e2, p);
            }
        }
        if (mtime > 0) f.setLastModified(mtime);
    }

    static void append(String p, byte[] data) throws NativeError {
        File f = new File(p);
        File dir = f.getParentFile();
        if (dir != null) mkdirs(dir.getPath());
        try (FileOutputStream out = new FileOutputStream(f, true)) {
            out.write(data);
        } catch (IOException e) {
            throw error(e, p);
        }
    }

    private static boolean sameFile(File a, File b) {
        try {
            StructStat x = Os.stat(a.getPath());
            StructStat y = Os.stat(b.getPath());
            return x.st_ino == y.st_ino && x.st_dev == y.st_dev;
        } catch (ErrnoException e) {
            return false;
        }
    }

    static void rename(String from, String to) throws NativeError {
        File a = new File(from);
        File b = new File(to);
        if (!a.exists()) throw new NativeError("ENOENT", from);
        // a change of letter case only is the same file on Android's shared storage
        if (b.exists() && !sameFile(a, b)) throw new NativeError("EEXIST", to);
        File dir = b.getParentFile();
        if (dir != null) mkdirs(dir.getPath());
        try {
            Os.rename(from, to);
        } catch (ErrnoException e) {
            if (e.errno != OsConstants.EXDEV) throw error(e, to);
            copyTree(a, b); // another storage volume: copy, then remove
            deleteTree(a);
        }
    }

    static void copy(String from, String to) throws NativeError {
        File a = new File(from);
        File b = new File(to);
        if (!a.exists()) throw new NativeError("ENOENT", from);
        if (b.exists()) throw new NativeError("EEXIST", to);
        File dir = b.getParentFile();
        if (dir != null) mkdirs(dir.getPath());
        copyTree(a, b);
    }

    private static void copyTree(File a, File b) throws NativeError {
        if (a.isDirectory()) {
            mkdirs(b.getPath());
            String[] names = a.list();
            if (names == null) throw new NativeError("EACCES", a.getPath());
            for (String name : names) copyTree(new File(a, name), new File(b, name));
            return;
        }
        try (InputStream in = new FileInputStream(a); OutputStream out = new FileOutputStream(b)) {
            pipe(in, out);
        } catch (IOException e) {
            throw error(e, b.getPath());
        }
        b.setLastModified(a.lastModified());
    }

    static void pipe(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    static boolean delete(String p, boolean recursive) throws NativeError {
        File f = new File(p);
        if (!f.exists()) return false;
        if (recursive) {
            deleteTree(f);
            return true;
        }
        try {
            Os.remove(p);
        } catch (ErrnoException e) {
            throw error(e, p);
        }
        return true;
    }

    static void deleteTree(File f) throws NativeError {
        if (f.isDirectory() && !Files.isSymbolicLink(f.toPath())) {
            String[] names = f.list();
            if (names != null) for (String name : names) deleteTree(new File(f, name));
        }
        if (!f.delete() && f.exists()) throw new NativeError("EACCES", f.getPath());
    }

    /** Unpack a zip into a folder; entries that would land outside it are refused. */
    static String unzip(String zip, String dest) throws NativeError {
        mkdirs(dest);
        try (ZipFile z = new ZipFile(zip)) {
            String base = new File(dest).getCanonicalPath();
            Enumeration<? extends ZipEntry> entries = z.entries();
            while (entries.hasMoreElements()) {
                ZipEntry e = entries.nextElement();
                File out = new File(base, e.getName()).getCanonicalFile();
                if (!out.getPath().startsWith(base + File.separator)) throw new NativeError("EINVAL", "entry outside the folder: " + e.getName());
                if (e.isDirectory()) {
                    mkdirs(out.getPath());
                    continue;
                }
                File dir = out.getParentFile();
                if (dir != null) mkdirs(dir.getPath());
                try (InputStream in = z.getInputStream(e); OutputStream o = new FileOutputStream(out)) {
                    pipe(in, o);
                }
            }
        } catch (IOException | IllegalArgumentException e) {
            throw error(e, zip);
        }
        return dest;
    }

    // ------------------------------------------------------------------ hash
    static JSONObject hash(String algo, byte[] data) throws NativeError, JSONException {
        String a = String.valueOf(algo).toLowerCase().replace("-", "");
        String name;
        if (a.equals("md5")) name = "MD5";
        else if (Arrays.asList("sha1", "sha224", "sha256", "sha384", "sha512").contains(a)) name = "SHA-" + a.substring(3);
        else throw new NativeError("unsupported", algo);
        byte[] d;
        try {
            d = MessageDigest.getInstance(name).digest(data);
        } catch (NoSuchAlgorithmException e) {
            throw new NativeError("unsupported", algo);
        }
        StringBuilder hex = new StringBuilder(d.length * 2);
        for (byte b : d) hex.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        return new JSONObject().put("hex", hex.toString()).put("b64", Base64.encodeToString(d, Base64.NO_WRAP));
    }
}
