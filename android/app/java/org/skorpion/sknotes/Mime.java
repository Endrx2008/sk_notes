// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.webkit.MimeTypeMap;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Content types of the files served to the page and handed to other apps. */
final class Mime {
    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("mjs", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("jpeg", "image/jpeg");
        TYPES.put("gif", "image/gif");
        TYPES.put("webp", "image/webp");
        TYPES.put("avif", "image/avif");
        TYPES.put("bmp", "image/bmp");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("woff", "font/woff");
        TYPES.put("ttf", "font/ttf");
        TYPES.put("pdf", "application/pdf");
        TYPES.put("md", "text/markdown");
        TYPES.put("txt", "text/plain");
        TYPES.put("canvas", "application/json");
        TYPES.put("base", "text/plain");
        TYPES.put("csv", "text/csv");
        TYPES.put("mp3", "audio/mpeg");
        TYPES.put("m4a", "audio/mp4");
        TYPES.put("ogg", "audio/ogg");
        TYPES.put("oga", "audio/ogg");
        TYPES.put("opus", "audio/ogg");
        TYPES.put("wav", "audio/wav");
        TYPES.put("flac", "audio/flac");
        TYPES.put("3gp", "video/3gpp");
        TYPES.put("mp4", "video/mp4");
        TYPES.put("m4v", "video/mp4");
        TYPES.put("webm", "video/webm");
        TYPES.put("ogv", "video/ogg");
        TYPES.put("mov", "video/quicktime");
        TYPES.put("mkv", "video/x-matroska");
        TYPES.put("zip", "application/zip");
    }

    private Mime() {
    }

    static String of(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "application/octet-stream";
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        String known = TYPES.get(ext);
        if (known != null) return known;
        String sys = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return sys != null ? sys : "application/octet-stream";
    }

    static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
    }
}
