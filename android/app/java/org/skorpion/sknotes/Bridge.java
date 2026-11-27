// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * `SkNative` of the page (see web/src/backend/native.js):
 *   boot()                            the key of this page load, given once
 *   call(key, method, json)           synchronous call, returns JSON
 *   callAsync(key, id, method, json)  runs on a worker thread, then the page gets __sknNative.r(id)
 *   take(key, id)                     JSON of a finished async call or of an event
 * Replies are {"ok":true,"result":…} or {"ok":false,"error":code,"detail":text}.
 *
 * The key is what keeps community plugins (which share the page) away from the native side: the
 * backend takes it before any plugin runs. Every load of the page gets a new key.
 */
final class Bridge {
    private static final String TAG = "sk_notes";
    private static final long BOOT_WAIT_MS = 4000;

    /** JSON text that is already built. */
    static final class Raw {
        final String json;

        Raw(String json) {
            this.json = json;
        }
    }

    private final MainActivity act;
    private final Net net = new Net();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<Integer, String> store = new ConcurrentHashMap<>();
    private final AtomicInteger eventId = new AtomicInteger(1000000000); // ids of the page's own calls start at 1
    private final SecureRandom random = new SecureRandom();

    // state of the page load, under `lock`
    private final Object lock = new Object();
    private String key = null;
    private boolean taken = true;
    private boolean pending = false; // the page is being requested: its key comes when it starts
    private boolean startSeen = false;
    private int order = 0; // which the WebView reports first for a load: 1 = the request, 2 = the start
    private int generation = 0;
    private boolean ready = false;
    private final List<String[]> waiting = new ArrayList<>(); // events kept until the page is ready

    Bridge(MainActivity act) {
        this.act = act;
    }

    // ------------------------------------------------------------------ page loads
    /** The page (index.html) is requested for the main frame: the page shown now loses the native side. */
    void pageRequested() {
        synchronized (lock) {
            if (order == 0) order = 1;
            if (order == 2 && startSeen) { // this WebView reports the start before the request
                startSeen = false;
                arm();
                return;
            }
            key = null;
            taken = true;
            pending = true;
            ready = false;
            generation++;
        }
        net.cancelAll();
    }

    /** The new page replaced the old one. */
    void pageStarted() {
        synchronized (lock) {
            if (order == 0) order = 2;
            if (!pending && order == 2) {
                startSeen = true;
                return;
            }
            arm(); // also a start whose request was not seen (a page kept by the WebView)
        }
    }

    private void arm() {
        byte[] b = new byte[24];
        random.nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        key = sb.toString();
        taken = false;
        pending = false;
        ready = false;
        generation++;
        store.clear();
        lock.notifyAll();
    }

    private boolean allowed(String k) {
        synchronized (lock) {
            return key != null && k != null && key.equals(k);
        }
    }

    boolean isReady() {
        synchronized (lock) {
            return ready;
        }
    }

    void shutdown() {
        synchronized (lock) {
            key = null;
            taken = true;
            generation++;
        }
        net.cancelAll();
        pool.shutdownNow();
    }

    // ------------------------------------------------------------------ the page's side
    @JavascriptInterface
    public String boot() {
        synchronized (lock) {
            long end = System.currentTimeMillis() + BOOT_WAIT_MS;
            while (pending) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) break;
                try {
                    lock.wait(left);
                } catch (InterruptedException e) {
                    return "";
                }
            }
            if (pending || taken || key == null) return "";
            taken = true;
            return key;
        }
    }

    @JavascriptInterface
    public String call(String k, String method, String json) {
        if (!allowed(k)) return failure(new NativeError("permission-denied"));
        return run(method, json);
    }

    @JavascriptInterface
    public void callAsync(String k, final int id, final String method, final String json) {
        if (!allowed(k)) return;
        final int gen;
        synchronized (lock) {
            gen = generation;
        }
        pool.execute(() -> {
            String reply = run(method, json);
            synchronized (lock) {
                if (gen != generation) return; // the page that asked is gone
                store.put(id, reply);
            }
            act.runJs("window.__sknNative&&window.__sknNative.r(" + id + ")");
        });
    }

    @JavascriptInterface
    public String take(String k, int id) {
        if (!allowed(k)) return "";
        String v = store.remove(id);
        return v == null ? "" : v;
    }

    // ------------------------------------------------------------------ events to the page
    /** An event for the page: `payload` is a JSONObject, a JSONArray or null. */
    void emit(String name, Object payload) {
        String json = toJson(payload);
        synchronized (lock) {
            if (key == null) return;
            send(name, json);
        }
    }

    /** An event that must not be lost when the page is still starting (a link, shared files). */
    void emitWhenReady(String name, Object payload) {
        String json = toJson(payload);
        synchronized (lock) {
            if (!ready) {
                waiting.add(new String[] { name, json });
                return;
            }
            send(name, json);
        }
    }

    private void send(String name, String json) {
        int id = eventId.incrementAndGet();
        store.put(id, json);
        act.runJs("window.__sknNative&&window.__sknNative.e(" + JSONObject.quote(name) + "," + id + ")");
    }

    private void markReady() {
        synchronized (lock) {
            ready = true;
            for (String[] e : waiting) send(e[0], e[1]);
            waiting.clear();
        }
    }

    // ------------------------------------------------------------------ replies
    static String toJson(Object v) {
        if (v == null || v == JSONObject.NULL) return "null";
        if (v instanceof Raw) return ((Raw) v).json;
        if (v instanceof String) return JSONObject.quote((String) v);
        return v.toString(); // Boolean, Number, JSONObject, JSONArray
    }

    private static String failure(NativeError e) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(e.code) + ",\"detail\":" + JSONObject.quote(e.detail) + "}";
    }

    private String run(String method, String json) {
        try {
            JSONObject p = json == null || json.isEmpty() ? new JSONObject() : new JSONObject(json);
            return "{\"ok\":true,\"result\":" + toJson(dispatch(String.valueOf(method), p)) + "}";
        } catch (NativeError e) {
            return failure(e);
        } catch (JSONException e) {
            return failure(new NativeError("EINVAL", String.valueOf(e.getMessage())));
        } catch (OutOfMemoryError e) {
            return failure(new NativeError("EFBIG", method));
        } catch (RuntimeException e) {
            Log.e(TAG, "native call failed: " + method, e);
            return failure(new NativeError("native-error", method + ": " + e));
        }
    }

    private Object dispatch(String m, JSONObject p) throws NativeError, JSONException {
        switch (m) {
            // ---- files
            case "fs.stat": return Fs.stat(Fs.path(p, "path"));
            case "fs.exists": return new java.io.File(Fs.path(p, "path")).exists();
            case "fs.list": return Fs.list(Fs.path(p, "path"));
            case "fs.scan": return Fs.scan(Fs.path(p, "path"), p.optJSONArray("ignore"), p.optBoolean("skipHidden", true));
            case "fs.readText": return Fs.readText(Fs.path(p, "path"), p.optInt("max", 0));
            case "fs.readTexts": return Fs.readTexts(p.optJSONArray("paths"));
            case "fs.readB64": return Fs.readB64(Fs.path(p, "path"));
            case "fs.readRange": return Fs.readRange(Fs.path(p, "path"), p.optLong("offset", 0), p.optInt("length", 0));
            case "fs.writeText": {
                String path = Fs.path(p, "path");
                Fs.writeAtomic(path, p.optString("text", "").getBytes(StandardCharsets.UTF_8), p.optLong("mtime", 0));
                return Fs.stat(path);
            }
            case "fs.writeB64": {
                String path = Fs.path(p, "path");
                Fs.writeAtomic(path, Fs.unB64(p.optString("b64", "")), p.optLong("mtime", 0));
                return Fs.stat(path);
            }
            case "fs.append":
                Fs.append(Fs.path(p, "path"), p.isNull("b64") ? p.optString("text", "").getBytes(StandardCharsets.UTF_8) : Fs.unB64(p.optString("b64", "")));
                return true;
            case "fs.mkdirs":
                Fs.mkdirs(Fs.path(p, "path"));
                return true;
            case "fs.rename":
                Fs.rename(Fs.path(p, "from"), Fs.path(p, "to"));
                return true;
            case "fs.copy":
                Fs.copy(Fs.path(p, "from"), Fs.path(p, "to"));
                return true;
            case "fs.delete": return Fs.delete(Fs.path(p, "path"), p.optBoolean("recursive", false));
            case "fs.unzip": return Fs.unzip(Fs.path(p, "path"), Fs.path(p, "dest"));
            case "fs.roots": return act.roots();
            case "hash": return Fs.hash(p.optString("algo", "sha256"), Fs.unB64(p.optString("b64", "")));

            // ---- storage permission
            case "perm.storage": return act.storageState();
            case "perm.requestStorage": return act.requestStorage();

            // ---- app
            case "app.device": return act.device();
            case "app.ready":
                markReady();
                return true;
            case "app.exit":
                act.exit();
                return true;
            case "app.background":
                act.background();
                return true;
            case "app.reload":
                act.reload();
                return true;

            // ---- what the user sees
            case "ui.zoom":
                act.setZoom(p.optDouble("zoom", 1.0));
                return true;
            case "ui.fullscreen": return act.toggleFullscreen();
            case "ui.bars":
                act.setBars(p.optString("color", "#0d0d0d"), p.optBoolean("light", false));
                return true;
            case "ui.confirm": return act.ask(p, false) == 0;
            case "ui.choose": return act.ask(p, true);
            case "ui.printHtml": return act.printHtml(p.optString("name", "sk_notes"), p.optString("html", ""));
            case "ui.pickFiles": return act.pickFiles(p.optBoolean("multiple", true), p.optJSONArray("mime"));

            // ---- other apps
            case "clip.read": return act.clipRead();
            case "clip.write":
                act.clipWrite(p.optString("text", ""));
                return true;
            case "sys.openExternal": return act.openExternal(p.optString("url", ""));
            case "sys.openPath": return act.openPath(Fs.path(p, "path"));
            case "sys.openFolder": return act.openFolder(Fs.path(p, "path"));
            case "sys.share": return act.share(p.optString("text", ""), p.optString("path", ""), p.optString("title", ""));
            case "sys.hasApp": return act.hasApp(p.optJSONArray("packages"));

            // ---- secrets (the password or token of the Git sync)
            case "secret.set":
                Secrets.set(act, p.optString("name", ""), p.optString("value", ""));
                return true;
            case "secret.get": {
                String v = Secrets.get(act, p.optString("name", ""));
                return v == null ? JSONObject.NULL : v;
            }
            case "secret.delete": return Secrets.delete(act, p.optString("name", ""));

            // ---- reminders of the notes (alarms + notifications) and home-screen widgets
            case "reminders.set":
                Reminders.store(act, p.optString("vault", ""), p);
                return true;
            case "reminders.permission": return act.requestNotifications();
            case "widgets.notes":
                Widgets.storeNotes(act, p);
                return true;
            case "widgets.changed":
                Widgets.noteChanged(act, p.optString("path", ""));
                return true;
            case "widgets.graph":
                Widgets.storeGraph(act, p);
                return true;

            // ---- network
            case "net.policy":
                act.setAllowRemote(p.optBoolean("allowRemote", false));
                return true;
            case "net.allowFrame":
                act.allowFrameHost(p.optString("host", ""));
                return true;
            case "net.request": return net.request(p);
            case "net.stream":
                return net.stream(p, (id, line) -> {
                    try {
                        emit("net.line", new JSONObject().put("id", id).put("line", line));
                    } catch (JSONException e) {
                        Log.w(TAG, "line not sent", e);
                    }
                });
            case "net.cancel": return net.cancel(p.opt("id"));
            case "net.scan": return net.scan(p);
            default:
                throw new NativeError("unknown-method", m);
        }
    }
}
