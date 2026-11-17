// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.Proxy;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** The network calls of the bridge (net.*): requests made for the backend, never by the page. */
final class Net {
    /** Receives the lines of a streamed reply, in order. */
    interface Lines {
        void line(Object id, String line);
    }

    private static final class Stream {
        volatile HttpURLConnection conn;
        volatile boolean cancelled;
    }

    private final Map<String, Stream> streams = new ConcurrentHashMap<>();

    private static String reason(Throwable e) {
        if (e instanceof SocketTimeoutException) return "timed out";
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    private static HttpURLConnection open(JSONObject p, int readTimeoutS) throws IOException, NativeError {
        String address = p.optString("url", "");
        URL url = new URL(address);
        String scheme = String.valueOf(url.getProtocol()).toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) throw new NativeError("network-error", "bad address: " + address);
        // a PC of the local network is reached directly, never through a proxy
        HttpURLConnection c = (HttpURLConnection) (p.optBoolean("local", false) ? url.openConnection(Proxy.NO_PROXY) : url.openConnection());
        int seconds = Math.max(1, readTimeoutS);
        c.setConnectTimeout(Math.min(seconds, 20) * 1000);
        c.setReadTimeout(seconds * 1000);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        c.setRequestMethod(p.optString("method", "GET").toUpperCase(Locale.ROOT));
        JSONObject headers = p.optJSONObject("headers");
        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String k = it.next();
                c.setRequestProperty(k, headers.optString(k));
            }
        }
        String body = p.optString("body", "");
        if (!body.isEmpty()) {
            byte[] data = Fs.unB64(body);
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(data.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(data);
            }
        }
        return c;
    }

    /** {url, method, headers, body (base64), timeout (s), maxBytes, local, toFile} → {status, headers, b64}.
     * With toFile (a path) the reply is written to that file instead: {status, headers, file, size}.
     * Large downloads (Git) are then read back in pieces and never held whole in memory here. */
    JSONObject request(JSONObject p) throws NativeError, JSONException {
        long max = p.optLong("maxBytes", 0);
        String toFile = p.optString("toFile", "");
        HttpURLConnection c = null;
        try {
            c = open(p, p.optInt("timeout", 60));
            int status = c.getResponseCode();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            long size = 0;
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            OutputStream file = null;
            try {
                if (!toFile.isEmpty()) {
                    java.io.File target = new java.io.File(toFile);
                    java.io.File dir = target.getParentFile();
                    if (dir != null) dir.mkdirs();
                    file = new java.io.FileOutputStream(target);
                }
                if (in != null) {
                    try (InputStream body = in) {
                        byte[] buf = new byte[1 << 16];
                        int n;
                        while ((n = body.read(buf)) > 0) {
                            if (max > 0 && size + (long) n > max) throw new NativeError("too-large", p.optString("url"));
                            if (file != null) file.write(buf, 0, n); else out.write(buf, 0, n);
                            size += n;
                        }
                    }
                }
            } finally {
                if (file != null) file.close();
            }
            JSONObject headers = new JSONObject();
            for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                if (h.getKey() == null) continue;
                StringBuilder v = new StringBuilder();
                for (String s : h.getValue()) v.append(v.length() > 0 ? ", " : "").append(s);
                headers.put(h.getKey().toLowerCase(Locale.ROOT), v.toString());
            }
            JSONObject reply = new JSONObject().put("status", status).put("headers", headers);
            if (!toFile.isEmpty()) return reply.put("file", toFile).put("size", size);
            return reply.put("b64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        } catch (IOException | RuntimeException e) {
            throw new NativeError("network-error", reason(e));
        } catch (OutOfMemoryError e) {
            throw new NativeError("too-large", p.optString("url"));
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** A reply read line by line (the chat of SKAI): every line goes to `lines` before this returns.
     * {id, url, method, headers, body, timeout (s without data), maxLine} → {status} or, for an HTTP error, {status, body}. */
    JSONObject stream(JSONObject p, Lines lines) throws NativeError, JSONException {
        Object id = p.opt("id");
        String key = String.valueOf(id);
        int maxLine = p.optInt("maxLine", 4 * 1024 * 1024);
        Stream st = new Stream();
        streams.put(key, st);
        try {
            HttpURLConnection c = open(p, p.optInt("timeout", 120));
            st.conn = c;
            if (st.cancelled) throw new NativeError("cancelled");
            int status = c.getResponseCode();
            if (status >= 400) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                InputStream err = c.getErrorStream();
                if (err != null) {
                    try (InputStream body = err) {
                        byte[] buf = new byte[8192];
                        int n;
                        while (out.size() < 65536 && (n = body.read(buf)) > 0) out.write(buf, 0, n);
                    }
                }
                String text = new String(out.toByteArray(), StandardCharsets.UTF_8);
                return new JSONObject().put("status", status).put("body", text.length() > 65536 ? text.substring(0, 65536) : text);
            }
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream line = new ByteArrayOutputStream(4096);
                byte[] buf = new byte[1 << 14];
                int n;
                boolean tooLong = false;
                while (!tooLong && (n = in.read(buf)) > 0) {
                    int from = 0;
                    for (int i = 0; i < n; i++) {
                        if (buf[i] != '\n') continue;
                        line.write(buf, from, i - from);
                        lines.line(id, new String(line.toByteArray(), StandardCharsets.UTF_8));
                        line.reset();
                        from = i + 1;
                    }
                    line.write(buf, from, n - from);
                    tooLong = line.size() > (long) maxLine * 4; // the page refuses a line longer than maxLine characters
                }
                if (st.cancelled) throw new NativeError("cancelled");
                String rest = new String(line.toByteArray(), StandardCharsets.UTF_8);
                if (!rest.trim().isEmpty()) lines.line(id, rest);
            }
            return new JSONObject().put("status", status);
        } catch (IOException | RuntimeException e) {
            throw new NativeError(st.cancelled ? "cancelled" : "network-error", reason(e));
        } finally {
            streams.remove(key, st);
            if (st.conn != null) st.conn.disconnect();
        }
    }

    boolean cancel(Object id) {
        Stream st = streams.get(String.valueOf(id));
        if (st == null) return false;
        st.cancelled = true;
        HttpURLConnection c = st.conn;
        if (c != null) {
            // closing the socket can wait for the network: never on the thread of the page
            new Thread(c::disconnect, "skn-cancel").start();
        }
        return true;
    }

    void cancelAll() {
        for (String id : new ArrayList<>(streams.keySet())) cancel(id);
    }

    // ------------------------------------------------------------------ looking for SKAI on the network
    /** Addresses of the Wi-Fi/Ethernet networks this device is on (the /24 around its own address). */
    private static List<String> neighbours() {
        Set<String> out = new LinkedHashSet<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                String name = ni.getName() == null ? "" : ni.getName().toLowerCase(Locale.ROOT);
                // Wi-Fi, Ethernet, hotspot: never the mobile network (rmnet…) or a VPN
                if (!(name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("ap") || name.startsWith("swlan") || name.startsWith("softap"))) continue;
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    byte[] b = a.getAddress();
                    String base = (b[0] & 255) + "." + (b[1] & 255) + "." + (b[2] & 255) + ".";
                    for (int i = 1; i < 255; i++) if (i != (b[3] & 255)) out.add(base + i);
                }
            }
        } catch (IOException | RuntimeException e) {
            // no network: nothing to look at
        }
        return new ArrayList<>(out);
    }

    /** {port, path, timeout (ms)} → [{host, name, version}] of the PCs answering as Ollama. */
    JSONArray scan(JSONObject p) throws NativeError {
        final int port = p.optInt("port", 11434);
        final String path = p.optString("path", "/api/version");
        final int timeout = Math.max(100, Math.min(p.optInt("timeout", 500), 5000));
        List<String> hosts = neighbours();
        final List<JSONObject> found = Collections.synchronizedList(new ArrayList<JSONObject>());
        if (!hosts.isEmpty()) {
            ExecutorService pool = Executors.newFixedThreadPool(64);
            for (final String host : hosts) {
                pool.execute(() -> {
                    try (Socket s = new Socket(Proxy.NO_PROXY)) {
                        s.connect(new InetSocketAddress(host, port), timeout);
                    } catch (IOException | RuntimeException e) {
                        return;
                    }
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new URL("http://" + host + ":" + port + path).openConnection(Proxy.NO_PROXY);
                        c.setConnectTimeout(timeout);
                        c.setReadTimeout(Math.max(timeout, 1500));
                        if (c.getResponseCode() != 200) return;
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        try (InputStream in = c.getInputStream()) {
                            byte[] buf = new byte[2048];
                            int n;
                            while (out.size() < 8192 && (n = in.read(buf)) > 0) out.write(buf, 0, n);
                        }
                        JSONObject reply = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
                        if (!reply.has("version")) return;
                        found.add(new JSONObject().put("host", host).put("name", "").put("version", reply.optString("version")));
                    } catch (IOException | JSONException | RuntimeException e) {
                        // not Ollama
                    } finally {
                        if (c != null) c.disconnect();
                    }
                });
            }
            pool.shutdown();
            try {
                if (!pool.awaitTermination(60, TimeUnit.SECONDS)) pool.shutdownNow();
            } catch (InterruptedException e) {
                pool.shutdownNow();
                throw new NativeError("cancelled");
            }
        }
        List<JSONObject> rows = new ArrayList<>(found);
        Collections.sort(rows, (a, b) -> a.optString("host").compareTo(b.optString("host")));
        return new JSONArray(rows);
    }
}
