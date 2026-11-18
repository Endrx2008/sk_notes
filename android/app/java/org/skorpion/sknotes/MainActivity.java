// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The only screen of sk_notes: a WebView showing the workspace (assets/app), and the native
 * side the page's backend calls through {@link Bridge}.
 *
 * The page lives at https://appassets.androidplatform.net/app/ (a name reserved for pages
 * packed inside apps: nothing is ever asked to the network for it); vault files are served
 * to it under /vault/. Other addresses are refused unless a plugin holds the network permission.
 */
public final class MainActivity extends Activity {
    static final String TAG = "sk_notes";
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    private static final String START = ORIGIN + "/app/index.html";
    private static final int REQ_PICK = 1;
    private static final int REQ_STORAGE = 2;
    private static final int REQ_CHOOSER = 3;
    private static final int MIN_WEBVIEW = 111; // the page is built for Chromium 111 or newer
    private static final Pattern RANGE = Pattern.compile("^bytes=(\\d*)-(\\d*)$");

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private WebView printView;
    private Bridge bridge;
    private volatile boolean allowRemote = false;
    private final Set<String> frameHosts = ConcurrentHashMap.newKeySet(); // sites of the web cards of a canvas
    private final Object pdfLock = new Object();
    private volatile boolean dark = true;
    private volatile boolean fullscreen = false;
    private volatile int insetTop = 0;
    private volatile int insetBottom = 0;
    private CompletableFuture<Intent> pickWait;
    private CompletableFuture<Boolean> storageWait;
    private ValueCallback<Uri[]> chooserWait;

    // the open vault, read from the settings the backend writes
    private final Object vaultLock = new Object();
    private long vaultStamp = -1;
    private String vaultRoot = null;

    // ------------------------------------------------------------------ life cycle
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        dark = isNight(getResources().getConfiguration());
        root = new FrameLayout(this);
        root.setBackgroundColor(0xff0d0d0d);
        setContentView(root);
        setupInsets();
        if (saved == null) {
            // copies of picked and shared files of earlier runs
            for (String name : new String[] { "picked", "shared", "import" }) {
                try {
                    Fs.deleteTree(new File(getCacheDir(), name));
                } catch (NativeError e) {
                    Log.w(TAG, "cache not cleared: " + e.getMessage());
                }
            }
        }
        bridge = new Bridge(this);
        if (!createWeb()) return;
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }
        if (saved == null) handleIntent(getIntent());
        web.loadUrl(START);
    }

    private boolean createWeb() {
        try {
            web = new WebView(this);
        } catch (RuntimeException e) {
            Log.e(TAG, "no WebView", e);
            new AlertDialog.Builder(this).setMessage(R.string.webview_missing).setCancelable(false)
                    .setPositiveButton(android.R.string.ok, (d, w) -> finish()).show();
            return false;
        }
        web.setBackgroundColor(0xff0d0d0d);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setTextZoom(savedZoom());
        if (Build.VERSION.SDK_INT >= 29 && Build.VERSION.SDK_INT < 33) noForceDark(s); // the page has its own themes
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true); // sites shown inside canvas cards keep their sessions
        web.addJavascriptInterface(bridge, "SkNative");
        web.setWebViewClient(new PageClient());
        web.setWebChromeClient(new Chrome());
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        int major = webViewMajor();
        if (major > 0 && major < MIN_WEBVIEW) {
            new AlertDialog.Builder(this).setMessage(getString(R.string.webview_old, major, MIN_WEBVIEW))
                    .setPositiveButton(android.R.string.ok, null).show();
        }
        return true;
    }

    private static String webViewVersion() {
        try {
            PackageInfo pi = WebView.getCurrentWebViewPackage();
            return pi == null || pi.versionName == null ? "" : pi.versionName;
        } catch (RuntimeException e) {
            return "";
        }
    }

    private static int webViewMajor() {
        Matcher m = Pattern.compile("^(\\d+)\\.").matcher(webViewVersion());
        try {
            return m.find() ? Integer.parseInt(m.group(1)) : 0;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** The text size chosen in the settings (the page tells only when it changes). */
    private int savedZoom() {
        try {
            JSONObject o = new JSONObject(new String(Fs.readBytes(new File(getFilesDir(), "settings.json").getPath(), 1 << 20), StandardCharsets.UTF_8));
            double z = o.optDouble("zoom", 1.0);
            if (Double.isNaN(z)) z = 1.0;
            return (int) Math.round(Math.max(0.5, Math.min(3.0, z)) * 100);
        } catch (NativeError | JSONException e) {
            return 100;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null) return;
        web.onResume();
        bridge.emit("app.resume", null);
    }

    @Override
    protected void onPause() {
        if (web != null) {
            bridge.emit("app.pause", null); // the page writes what is still unsaved
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (pickWait != null) pickWait.complete(null);
        if (storageWait != null) storageWait.complete(false);
        if (web != null) {
            root.removeView(web);
            web.removeJavascriptInterface("SkNative");
            web.destroy();
            web = null;
        }
        if (printView != null) {
            printView.destroy();
            printView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        boolean night = isNight(c);
        if (night == dark) return;
        dark = night;
        try {
            bridge.emit("ui.theme", new JSONObject().put("dark", night));
        } catch (JSONException e) {
            Log.w(TAG, "theme not sent", e);
        }
    }

    private static boolean isNight(Configuration c) {
        return (c.uiMode & Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_NO;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        back();
    }

    /** Back closes what is open in the page; the page asks for the background when nothing is left. */
    private void back() {
        if (web != null && bridge.isReady()) bridge.emit("back", null);
        else moveTaskToBack(true);
    }

    // ------------------------------------------------------------------ window
    /** Android 10-12 only: from 13 the WebView follows the page's own colour scheme instead. */
    @SuppressWarnings("deprecation")
    private static void noForceDark(WebSettings s) {
        s.setForceDark(WebSettings.FORCE_DARK_OFF);
    }

    /** Android 11-14: the page draws behind the system bars (from 15 it always does). */
    @SuppressWarnings("deprecation")
    private void drawBehindBars() {
        if (Build.VERSION.SDK_INT < 35) getWindow().setDecorFitsSystemWindows(false);
    }

    private void setupInsets() {
        if (Build.VERSION.SDK_INT < 30) return; // older systems fit the window themselves
        drawBehindBars();
        root.setOnApplyWindowInsetsListener((v, in) -> {
            Insets i = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            insetTop = i.top;
            insetBottom = i.bottom;
            return WindowInsets.CONSUMED;
        });
    }

    @SuppressWarnings("deprecation")
    void setBars(final String color, final boolean light) {
        ui.post(() -> {
            int c;
            try {
                c = Color.parseColor(color);
            } catch (IllegalArgumentException e) {
                return;
            }
            root.setBackgroundColor(c);
            getWindow().setStatusBarColor(c);
            getWindow().setNavigationBarColor(c);
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController ctl = getWindow().getInsetsController();
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                if (ctl != null) ctl.setSystemBarsAppearance(light ? mask : 0, mask);
            } else {
                View decor = getWindow().getDecorView();
                int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                decor.setSystemUiVisibility(light ? decor.getSystemUiVisibility() | flags : decor.getSystemUiVisibility() & ~flags);
            }
        });
    }

    @SuppressWarnings("deprecation")
    boolean toggleFullscreen() {
        final boolean on = !fullscreen;
        fullscreen = on;
        ui.post(() -> {
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController ctl = getWindow().getInsetsController();
                if (ctl == null) return;
                if (on) {
                    ctl.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    ctl.hide(WindowInsets.Type.systemBars());
                } else ctl.show(WindowInsets.Type.systemBars());
            } else {
                View decor = getWindow().getDecorView();
                int flags = View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
                decor.setSystemUiVisibility(on ? decor.getSystemUiVisibility() | flags : decor.getSystemUiVisibility() & ~flags);
            }
        });
        return on;
    }

    void setZoom(final double zoom) {
        ui.post(() -> {
            if (web != null) web.getSettings().setTextZoom((int) Math.round(Math.max(0.5, Math.min(3.0, zoom)) * 100));
        });
    }

    void runJs(final String js) {
        ui.post(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    void exit() {
        ui.post(this::finishAndRemoveTask);
    }

    void background() {
        ui.post(() -> moveTaskToBack(true));
    }

    void reload() {
        ui.post(() -> {
            if (web != null) web.reload();
        });
    }

    void setAllowRemote(boolean allow) {
        allowRemote = allow;
    }

    JSONObject device() throws JSONException {
        float density = getResources().getDisplayMetrics().density;
        return new JSONObject().put("dark", dark).put("sdk", Build.VERSION.SDK_INT).put("model", Build.MANUFACTURER + " " + Build.MODEL)
                .put("webview", webViewVersion())
                .put("insets", new JSONObject().put("top", Math.round(insetTop / density)).put("bottom", Math.round(insetBottom / density)));
    }

    // ------------------------------------------------------------------ storage
    private File appVaults() {
        File ext = getExternalFilesDir(null);
        File d = new File(ext != null ? ext : getFilesDir(), "vaults");
        if (!d.isDirectory() && !d.mkdirs() && ext != null) d = new File(getFilesDir(), "vaults");
        d.mkdirs();
        return d;
    }

    private boolean storageGranted() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    /** Where files live: the app's own folders and, with the permission, the shared storage. */
    @SuppressWarnings("deprecation")
    JSONObject roots() throws JSONException {
        boolean granted = storageGranted();
        File shared = Environment.getExternalStorageDirectory();
        JSONArray volumes = new JSONArray();
        if (granted) {
            File[] dirs = getExternalFilesDirs(null);
            for (int i = 1; dirs != null && i < dirs.length; i++) { // 0 is the device storage itself
                if (dirs[i] == null) continue;
                String p = dirs[i].getPath();
                int cut = p.indexOf("/Android/");
                if (cut > 0) volumes.put(p.substring(0, cut));
            }
        }
        return new JSONObject().put("private", getFilesDir().getPath()).put("cache", getCacheDir().getPath()).put("appVaults", appVaults().getPath())
                .put("shared", granted ? shared.getPath() : JSONObject.NULL)
                .put("documents", granted ? new File(shared, "Documents").getPath() : JSONObject.NULL)
                .put("volumes", volumes);
    }

    JSONObject storageState() throws JSONException {
        return new JSONObject().put("granted", storageGranted()).put("canAsk", true);
    }

    /** Ask for the shared storage (Android's "access to all files" screen); waits for the answer. */
    boolean requestStorage() throws NativeError {
        if (storageGranted()) return true;
        final CompletableFuture<Boolean> f = new CompletableFuture<>();
        ui.post(() -> {
            if (storageWait != null) storageWait.complete(false);
            storageWait = f;
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName()));
                    try {
                        startActivityForResult(i, REQ_STORAGE);
                    } catch (ActivityNotFoundException e) {
                        startActivityForResult(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), REQ_STORAGE);
                    }
                } else {
                    requestPermissions(new String[] { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE }, REQ_STORAGE);
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "storage permission not asked", e);
                storageWait = null;
                f.complete(false);
            }
        });
        return await(f, false);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != REQ_STORAGE || storageWait == null) return;
        CompletableFuture<Boolean> f = storageWait;
        storageWait = null;
        f.complete(storageGranted());
    }

    private static <T> T await(CompletableFuture<T> f, T fallback) throws NativeError {
        if (Looper.myLooper() == Looper.getMainLooper()) throw new NativeError("native-error", "blocking call on the main thread");
        try {
            T v = f.get();
            return v == null ? fallback : v;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new NativeError("cancelled");
        } catch (ExecutionException e) {
            throw new NativeError("native-error", String.valueOf(e.getCause()));
        }
    }

    // ------------------------------------------------------------------ dialogs
    /** A question in a system dialog. Confirm: {title, text, detail, ok, cancel} → 0 (ok) or 1.
     * Choose: {title, text, detail, buttons: [once, always, deny]} → the index of the button. */
    int ask(final JSONObject p, final boolean choose) throws NativeError {
        final CompletableFuture<Integer> f = new CompletableFuture<>();
        ui.post(() -> {
            if (isFinishing() || isDestroyed()) {
                f.complete(-1);
                return;
            }
            String detail = p.optString("detail", "");
            AlertDialog.Builder b = new AlertDialog.Builder(this).setTitle(p.optString("title", "sk_notes"))
                    .setMessage(p.optString("text", "") + (detail.isEmpty() ? "" : "\n\n" + detail));
            if (choose) {
                JSONArray buttons = p.optJSONArray("buttons");
                if (buttons == null) buttons = new JSONArray();
                b.setCancelable(false);
                b.setPositiveButton(buttons.optString(0, "OK"), (d, w) -> f.complete(0));
                if (buttons.length() > 1) b.setNegativeButton(buttons.optString(1), (d, w) -> f.complete(1));
                if (buttons.length() > 2) b.setNeutralButton(buttons.optString(2), (d, w) -> f.complete(2));
            } else {
                String ok = p.optString("ok", "");
                String cancel = p.optString("cancel", "");
                b.setPositiveButton(ok.isEmpty() ? getString(android.R.string.ok) : ok, (d, w) -> f.complete(0));
                b.setNegativeButton(cancel.isEmpty() ? getString(android.R.string.cancel) : cancel, (d, w) -> f.complete(1));
                b.setOnCancelListener((d) -> f.complete(1));
            }
            try {
                b.show();
            } catch (WindowManager.BadTokenException e) {
                f.complete(-1);
            }
        });
        int answer = await(f, -1);
        if (answer < 0) {
            if (choose) throw new NativeError("native-error", "no window to ask in");
            return 1;
        }
        return answer;
    }

    /** Android's print dialog for a page of HTML ("Save as PDF" or a printer). */
    boolean printHtml(final String name, final String html) throws NativeError {
        final CompletableFuture<Boolean> f = new CompletableFuture<>();
        ui.post(() -> {
            try {
                if (printView != null) printView.destroy();
                final WebView v = new WebView(this);
                printView = v;
                v.getSettings().setJavaScriptEnabled(false);
                v.getSettings().setAllowFileAccess(false);
                v.getSettings().setAllowContentAccess(false);
                v.setWebViewClient(new WebViewClient() {
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        return intercept(request, false);
                    }

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (f.isDone()) return;
                        try {
                            PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                            pm.print(name, view.createPrintDocumentAdapter(name), new PrintAttributes.Builder().build());
                            f.complete(true);
                        } catch (RuntimeException e) {
                            f.completeExceptionally(e);
                        }
                    }
                });
                v.loadDataWithBaseURL(ORIGIN + "/app/print.html", html, "text/html", "utf-8", null);
            } catch (RuntimeException e) {
                f.completeExceptionally(e);
            }
        });
        return await(f, false);
    }

    // ------------------------------------------------------------------ files from other apps
    private File freshDir(String kind) {
        File d = new File(new File(getCacheDir(), kind), Long.toString(System.currentTimeMillis(), 36) + Integer.toString((int) (Math.random() * 46656), 36));
        d.mkdirs();
        return d;
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
            } catch (RuntimeException e) {
                name = null;
            }
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "file";
        name = name.replaceAll("[/\\\\:*?\"<>|\\u0000-\\u001f]", "-").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "file";
        if (name.indexOf('.') < 0) { // no extension: take it from the type
            String type = getContentResolver().getType(uri);
            String ext = type == null ? null : android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
            if (ext != null && !ext.isEmpty()) name = name + "." + ext;
        }
        return name;
    }

    /** A copy of a file another app handed over, in the app's cache: {path, name}. */
    private JSONObject copyIn(Uri uri, File dir) throws IOException, JSONException {
        String name = displayName(uri);
        File out = new File(dir, name);
        for (int n = 2; out.exists(); n++) {
            int dot = name.lastIndexOf('.');
            out = new File(dir, dot > 0 ? name.substring(0, dot) + " " + n + name.substring(dot) : name + " " + n);
        }
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("no data: " + uri);
            try (OutputStream o = new FileOutputStream(out)) {
                Fs.pipe(in, o);
            }
        }
        return new JSONObject().put("path", out.getPath()).put("name", out.getName());
    }

    private static List<Uri> urisOf(Intent data) {
        List<Uri> out = new ArrayList<>();
        if (data == null) return out;
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null && !out.contains(u)) out.add(u);
            }
        }
        if (data.getData() != null && !out.contains(data.getData())) out.add(data.getData());
        return out;
    }

    /** Android's file chooser; the chosen files come back as copies in the cache: [{path, name}]. */
    JSONArray pickFiles(final boolean multiple, final JSONArray mime) throws NativeError, JSONException {
        final CompletableFuture<Intent> f = new CompletableFuture<>();
        ui.post(() -> {
            if (pickWait != null) pickWait.complete(null);
            pickWait = f;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE);
            List<String> types = new ArrayList<>();
            for (int k = 0; mime != null && k < mime.length(); k++) types.add(mime.optString(k));
            if (types.size() == 1) i.setType(types.get(0));
            else {
                i.setType("*/*");
                if (!types.isEmpty() && !types.contains("*/*")) i.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
            }
            if (multiple) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(i, REQ_PICK);
            } catch (RuntimeException e) {
                Log.w(TAG, "no file chooser", e);
                pickWait = null;
                f.complete(null);
            }
        });
        JSONArray out = new JSONArray();
        Intent data = await(f, null);
        List<Uri> uris = urisOf(data);
        if (uris.isEmpty()) return out;
        File dir = freshDir("picked");
        for (Uri u : uris) {
            try {
                out.put(copyIn(u, dir));
            } catch (IOException | RuntimeException e) {
                throw Fs.error(e, String.valueOf(u));
            }
        }
        return out;
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == REQ_PICK && pickWait != null) {
            CompletableFuture<Intent> f = pickWait;
            pickWait = null;
            f.complete(result == RESULT_OK ? data : null);
        } else if (code == REQ_STORAGE && storageWait != null) {
            CompletableFuture<Boolean> f = storageWait;
            storageWait = null;
            f.complete(storageGranted());
        } else if (code == REQ_CHOOSER && chooserWait != null) {
            ValueCallback<Uri[]> cb = chooserWait;
            chooserWait = null;
            cb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        }
    }

    /** What sk_notes was opened with: a sknotes:// link, or text and files shared by another app. */
    @SuppressWarnings("deprecation")
    private void handleIntent(final Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        try {
            if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
                bridge.emitWhenReady("app.uri", new JSONObject().put("uri", intent.getData().toString()));
                return;
            }
            if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
            final List<Uri> uris = new ArrayList<>();
            if (Intent.ACTION_SEND.equals(action)) {
                Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) uris.add(u);
            } else {
                ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (many != null) for (Uri u : many) if (u != null) uris.add(u);
            }
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            final JSONObject payload = new JSONObject().put("text", text == null ? "" : text.toString())
                    .put("title", String.valueOf(intent.getStringExtra(Intent.EXTRA_SUBJECT) == null ? "" : intent.getStringExtra(Intent.EXTRA_SUBJECT)));
            // copying can take a while: not on the main thread
            new Thread(() -> {
                JSONArray files = new JSONArray();
                File dir = uris.isEmpty() ? null : freshDir("shared");
                for (Uri u : uris) {
                    // only what the other app handed over: never a file of sk_notes itself
                    if (!"content".equals(u.getScheme())) continue;
                    try {
                        files.put(copyIn(u, dir));
                    } catch (IOException | JSONException | RuntimeException e) {
                        Log.w(TAG, "shared file not read: " + u, e);
                    }
                }
                try {
                    bridge.emitWhenReady("app.share", payload.put("files", files));
                } catch (JSONException e) {
                    Log.w(TAG, "share not sent", e);
                }
            }, "skn-share").start();
        } catch (JSONException | RuntimeException e) {
            Log.w(TAG, "intent not handled", e);
        }
    }

    // ------------------------------------------------------------------ clipboard
    /** The text on Android's clipboard ("" when there is none or it is not text). */
    String clipRead() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(this);
            return text == null ? "" : text.toString();
        } catch (RuntimeException e) {
            Log.w(TAG, "clipboard not read: " + e);
            return "";
        }
    }

    void clipWrite(String text) throws NativeError {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) throw new NativeError("native-error", "no clipboard");
            cm.setPrimaryClip(ClipData.newPlainText("sk_notes", text));
        } catch (RuntimeException e) {
            throw new NativeError("native-error", String.valueOf(e.getMessage()));
        }
    }

    // ------------------------------------------------------------------ other apps
    boolean openExternal(String url) {
        String scheme = String.valueOf(Uri.parse(url).getScheme()).toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https") && !scheme.equals("mailto")) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** Open a file with the app the user has for it. */
    boolean openPath(String path) throws NativeError {
        File f = new File(path);
        if (!f.isFile()) throw new NativeError("ENOENT", path);
        Uri uri = VaultProvider.uriFor(f);
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, Mime.of(f.getName())).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        i.setClipData(ClipData.newRawUri("", uri));
        try {
            startActivity(Intent.createChooser(i, null));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** Show a folder of the device storage in the system's file manager (where there is one that can). */
    @SuppressWarnings("deprecation")
    boolean openFolder(String path) {
        String base = Environment.getExternalStorageDirectory().getPath();
        if (!path.equals(base) && !path.startsWith(base + "/")) return false;
        String rel = path.length() > base.length() ? path.substring(base.length() + 1) : "";
        Uri uri = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + rel);
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, DocumentsContract.Document.MIME_TYPE_DIR)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(i);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    boolean share(String text, String path, String title) throws NativeError {
        Intent i = new Intent(Intent.ACTION_SEND);
        if (!path.isEmpty()) {
            File f = new File(path);
            if (!f.isFile()) throw new NativeError("ENOENT", path);
            Uri uri = VaultProvider.uriFor(f);
            i.setType(Mime.of(f.getName())).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.setClipData(ClipData.newRawUri("", uri));
            if (!text.isEmpty()) i.putExtra(Intent.EXTRA_TEXT, text);
        } else {
            i.setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
        }
        if (!title.isEmpty()) i.putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TITLE, title);
        try {
            startActivity(Intent.createChooser(i, title.isEmpty() ? null : title));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    boolean hasApp(JSONArray packages) {
        for (int k = 0; packages != null && k < packages.length(); k++) {
            try {
                getPackageManager().getPackageInfo(packages.optString(k), 0);
                return true;
            } catch (PackageManager.NameNotFoundException | RuntimeException e) {
                // not installed
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ what the page may load
    private static WebResourceResponse plain(int status, String reason) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers, new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    /** Answers every request of the page: the app's files, vault files, and nothing else
     * unless a plugin holds the network permission. `page` is false for the print view. */
    WebResourceResponse intercept(WebResourceRequest request, boolean page) {
        Uri u = request.getUrl();
        String scheme = String.valueOf(u.getScheme()).toLowerCase(Locale.ROOT);
        if (scheme.equals("https") && HOST.equalsIgnoreCase(u.getHost())) {
            String path = u.getPath() == null ? "/" : u.getPath();
            try {
                if (path.startsWith("/app/")) {
                    String rel = path.substring(5);
                    if (page && request.isForMainFrame() && rel.equals("index.html")) bridge.pageRequested();
                    return asset(rel);
                }
                if (path.startsWith("/vault/")) return vaultFile(path.substring(7), request);
                if (path.startsWith("/pdf/")) return pdf(path.substring(5), u);
            } catch (IOException | RuntimeException e) {
                return plain(404, "Not Found");
            }
            return plain(404, "Not Found");
        }
        if (scheme.equals("data") || scheme.equals("blob") || scheme.equals("about")) return null;
        if (!scheme.equals("https") && !scheme.equals("http")) return allowRemote ? null : plain(403, "Forbidden");
        // Sites the user put on a board (web cards of a canvas) load inside frames:
        //  - the site itself: its host was allowed by the backend (net.allowFrame);
        //  - what its pages ask for: those requests name another site as their referrer,
        //    which only a frame can do (the app's page always names itself, or nothing).
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
        String referer = header(request, "Referer");
        boolean card = frameHosts.contains(host);
        boolean fromFrame = !frameHosts.isEmpty() && referer != null && !referer.isEmpty() && !referer.startsWith(ORIGIN);
        if (!allowRemote && !card && !fromFrame) return plain(403, "Forbidden");
        if (card && !request.isForMainFrame() && "GET".equalsIgnoreCase(request.getMethod())) {
            String accept = header(request, "Accept");
            if (accept != null && accept.startsWith("text/html")) {
                WebResourceResponse doc = framedDocument(request);
                if (doc != null) return doc;
            }
        }
        return null;
    }

    private static String header(WebResourceRequest request, String name) {
        for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) if (name.equalsIgnoreCase(h.getKey())) return h.getValue();
        return null;
    }

    void allowFrameHost(String host) {
        if (host != null && !host.isEmpty()) frameHosts.add(host.toLowerCase(Locale.ROOT));
    }

    /** The page of a web card, fetched here so that it can be shown inside the card: most sites
     * tell browsers not to show them in a frame of another page (X-Frame-Options, frame-ancestors).
     * Here the frame is the user's own board, so those two answers are left out; everything else
     * of the reply is kept. Null lets the WebView load the address itself. */
    private WebResourceResponse framedDocument(WebResourceRequest request) {
        String address = request.getUrl().toString();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(address).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
                String k = h.getKey();
                if (k.equalsIgnoreCase("Accept-Encoding") || k.equalsIgnoreCase("Cookie") || k.equalsIgnoreCase("Range")) continue;
                c.setRequestProperty(k, h.getValue());
            }
            CookieManager cookies = CookieManager.getInstance();
            String jar = cookies.getCookie(address);
            if (jar != null && !jar.isEmpty()) c.setRequestProperty("Cookie", jar);
            int status = c.getResponseCode();
            Map<String, String> headers = new HashMap<>();
            String type = null;
            for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                String k = h.getKey();
                if (k == null || h.getValue() == null) continue;
                String low = k.toLowerCase(Locale.ROOT);
                if (low.equals("set-cookie")) {
                    for (String v : h.getValue()) cookies.setCookie(address, v);
                    continue;
                }
                if (low.equals("x-frame-options") || low.equals("content-length") || low.equals("content-encoding") || low.equals("transfer-encoding")
                        || low.startsWith("x-android-")) continue;
                StringBuilder all = new StringBuilder();
                for (String v : h.getValue()) all.append(all.length() > 0 ? ", " : "").append(v);
                String value = all.toString();
                if (low.equals("content-type")) type = value;
                if (low.equals("content-security-policy")) {
                    StringBuilder kept = new StringBuilder();
                    for (String part : value.split(";")) {
                        if (part.trim().toLowerCase(Locale.ROOT).startsWith("frame-ancestors")) continue;
                        if (!part.trim().isEmpty()) kept.append(kept.length() > 0 ? "; " : "").append(part.trim());
                    }
                    if (kept.length() == 0) continue;
                    value = kept.toString();
                }
                headers.put(k, value);
            }
            if (status >= 300 && status < 400) {
                // a frame cannot be answered with a redirect: send the frame to the new address
                String location = c.getHeaderField("Location");
                c.disconnect();
                if (location == null) return null;
                URL target = new URL(new URL(address), location);
                if (target.getHost() != null && "https".equalsIgnoreCase(target.getProtocol())) frameHosts.add(target.getHost().toLowerCase(Locale.ROOT));
                String html = "<!doctype html><meta charset=\"utf-8\"><script>location.replace(" + JSONObject.quote(target.toString()).replace("</", "<\\/") + ")</script>";
                Map<String, String> none = new HashMap<>();
                none.put("Cache-Control", "no-store");
                return new WebResourceResponse("text/html", "utf-8", 200, "OK", none, new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
            }
            String mime = "text/html";
            String charset = null;
            if (type != null) {
                String[] parts = type.split(";");
                if (!parts[0].trim().isEmpty()) mime = parts[0].trim().toLowerCase(Locale.ROOT);
                for (int i = 1; i < parts.length; i++) {
                    String part = parts[i].trim();
                    if (part.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = part.substring(8).replace("\"", "").trim();
                }
            }
            headers.remove("Content-Type");
            headers.remove("content-type");
            final HttpURLConnection conn = c;
            InputStream body = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);
            InputStream closing = new FilterInputStream(body) {
                @Override
                public void close() throws IOException {
                    try {
                        super.close();
                    } finally {
                        conn.disconnect();
                    }
                }
            };
            String reason = c.getResponseMessage();
            return new WebResourceResponse(mime, charset, status, reason == null || reason.isEmpty() ? "OK" : reason, headers, closing);
        } catch (IOException | RuntimeException e) {
            if (c != null) c.disconnect();
            Log.w(TAG, "page of a web card not fetched here: " + e);
            return null;
        }
    }

    // ------------------------------------------------------------------ PDF pages
    /** /pdf/<path in the vault> → {pages, sizes}; with ?page=N&w=W → that page as a picture. */
    private WebResourceResponse pdf(String rel, Uri u) throws IOException {
        File f = vaultPath(rel);
        if (f == null) return plain(404, "Not Found");
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        synchronized (pdfLock) { // one PDF at a time: pages are big pictures
            try (ParcelFileDescriptor fd = ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY); PdfRenderer r = new PdfRenderer(fd)) {
                int count = r.getPageCount();
                String wanted = u.getQueryParameter("page");
                if (wanted == null) {
                    JSONArray sizes = new JSONArray();
                    for (int i = 0; i < count && i < 5000; i++) {
                        try (PdfRenderer.Page p = r.openPage(i)) {
                            sizes.put(new JSONArray().put(p.getWidth()).put(p.getHeight()));
                        }
                    }
                    String json = new JSONObject().put("pages", count).put("sizes", sizes).toString();
                    return new WebResourceResponse("application/json", "utf-8", 200, "OK", headers, new ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8)));
                }
                int index = Integer.parseInt(wanted) - 1;
                if (index < 0 || index >= count) return plain(404, "Not Found");
                int width = 1080;
                try {
                    width = Math.max(200, Math.min(2400, Integer.parseInt(String.valueOf(u.getQueryParameter("w")))));
                } catch (NumberFormatException e) {
                    width = 1080;
                }
                try (PdfRenderer.Page p = r.openPage(index)) {
                    int height = Math.max(1, Math.round(width * (float) p.getHeight() / Math.max(1, p.getWidth())));
                    if (height > 6000) { // a very tall page: keep the picture within what a phone can hold
                        width = Math.max(1, Math.round(width * 6000f / height));
                        height = 6000;
                    }
                    Bitmap bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                    try {
                        bmp.eraseColor(Color.WHITE);
                        p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        ByteArrayOutputStream out = new ByteArrayOutputStream(width * height / 8);
                        bmp.compress(Bitmap.CompressFormat.JPEG, 88, out);
                        return new WebResourceResponse("image/jpeg", null, 200, "OK", headers, new ByteArrayInputStream(out.toByteArray()));
                    } finally {
                        bmp.recycle();
                    }
                }
            } catch (JSONException | SecurityException | NumberFormatException | OutOfMemoryError e) {
                Log.w(TAG, "PDF not drawn: " + e);
                return plain(500, "PDF not readable");
            }
        }
    }

    private WebResourceResponse asset(String rel) throws IOException {
        if (rel.isEmpty() || rel.contains("..") || rel.startsWith("/")) return plain(404, "Not Found");
        InputStream in = getAssets().open("app/" + rel);
        String mime = Mime.of(rel);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", rel.equals("index.html") ? "no-store" : "no-cache");
        return new WebResourceResponse(mime, Mime.isText(mime) ? "utf-8" : null, 200, "OK", headers, in);
    }

    /** The vault that is open, as the backend wrote it in its settings. */
    private String vaultRoot() {
        File settings = new File(getFilesDir(), "settings.json");
        long stamp = settings.lastModified() ^ (settings.length() << 20);
        synchronized (vaultLock) {
            if (stamp == vaultStamp) return vaultRoot;
            String found = null;
            try {
                found = new JSONObject(new String(Fs.readBytes(settings.getPath(), 1 << 20), StandardCharsets.UTF_8)).optString("lastVault", "");
            } catch (NativeError | JSONException e) {
                found = null;
            }
            vaultStamp = stamp;
            vaultRoot = found == null || found.isEmpty() ? null : found;
            return vaultRoot;
        }
    }

    /** Stops after `left` bytes: the part of a file a media element asked for. */
    private static final class Slice extends FilterInputStream {
        private long left;

        Slice(InputStream in, long left) {
            super(in);
            this.left = left;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }

    /** A file of the open vault by its path inside it; null when it is not there or not inside. */
    private File vaultPath(String rel) throws IOException {
        String rootPath = vaultRoot();
        if (rootPath == null || rel.isEmpty()) return null;
        File base = new File(rootPath).getCanonicalFile();
        File f = new File(base, rel);
        if (!f.exists()) { // names kept in another Unicode form by a sync tool
            File nfd = new File(base, Normalizer.normalize(rel, Normalizer.Form.NFD));
            f = nfd.exists() ? nfd : new File(base, Normalizer.normalize(rel, Normalizer.Form.NFC));
        }
        f = f.getCanonicalFile();
        return f.getPath().startsWith(base.getPath() + File.separator) && f.isFile() ? f : null;
    }

    private WebResourceResponse vaultFile(String rel, WebResourceRequest request) throws IOException {
        File f = vaultPath(rel);
        if (f == null) return plain(404, "Not Found");
        String mime = Mime.of(f.getName());
        String encoding = Mime.isText(mime) ? "utf-8" : null;
        long size = f.length();
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-cache");
        String range = null;
        for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) if ("range".equalsIgnoreCase(h.getKey())) range = h.getValue();
        Matcher m = range == null ? null : RANGE.matcher(range.trim());
        if (m != null && m.matches() && size > 0 && !(m.group(1).isEmpty() && m.group(2).isEmpty())) {
            long start;
            long end = size - 1;
            try {
                if (m.group(1).isEmpty()) start = Math.max(0, size - Long.parseLong(m.group(2))); // the last N bytes
                else {
                    start = Long.parseLong(m.group(1));
                    if (!m.group(2).isEmpty()) end = Math.min(Long.parseLong(m.group(2)), size - 1);
                }
            } catch (NumberFormatException e) {
                start = -1;
            }
            if (start >= 0 && start <= end) {
                FileInputStream in = new FileInputStream(f);
                long skipped = 0;
                while (skipped < start) {
                    long n = in.skip(start - skipped);
                    if (n <= 0) break;
                    skipped += n;
                }
                headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
                headers.put("Content-Length", Long.toString(end - start + 1));
                return new WebResourceResponse(mime, encoding, 206, "Partial Content", headers, new Slice(in, end - start + 1));
            }
        }
        headers.put("Content-Length", Long.toString(size));
        return new WebResourceResponse(mime, encoding, 200, "OK", headers, new FileInputStream(f));
    }

    private final class PageClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return intercept(request, true);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (url != null && url.startsWith(ORIGIN + "/app/")) bridge.pageStarted();
        }

        /** The window never leaves the app's page: links go to the browser when the user tapped them. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (!request.isForMainFrame()) return false; // frames inside notes: what they load is decided by intercept()
            if (url.startsWith(ORIGIN + "/app/")) return false;
            if (request.hasGesture()) openExternal(url);
            return true;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // the page's process was stopped (low memory) or crashed: start again instead of closing
            Log.w(TAG, "page process gone, crashed=" + detail.didCrash());
            if (view == web) {
                root.removeView(web);
                web.destroy();
                web = null;
                recreate();
            } else if (view == printView) {
                printView.destroy();
                printView = null;
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.e(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            else if (m.messageLevel() == ConsoleMessage.MessageLevel.WARNING) Log.w(TAG, m.message());
            return true;
        }

        /** <input type="file"> of the page or of a plugin. */
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (chooserWait != null) chooserWait.onReceiveValue(null);
            chooserWait = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_CHOOSER);
                return true;
            } catch (RuntimeException e) {
                chooserWait = null;
                return false;
            }
        }
    }
}
