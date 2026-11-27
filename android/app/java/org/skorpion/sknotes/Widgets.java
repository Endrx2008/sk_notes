// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.Calendar;
import java.util.Date;

/**
 * What the three home-screen widgets show, written by the page while sk_notes runs:
 *   things to do   every reminder of the notes (Reminders), with its date; a tap opens the note
 *   a note         one note chosen when the widget is placed (a shopping list…); a tap opens it
 *   the graph      a picture of the graph, taken when its dots stop moving; a tap opens the graph
 * Encrypted vaults never reach the widgets.
 */
final class Widgets {
    private static final String TAG = "sk_notes";
    static final String NOTES_FILE = "widget-notes.json";
    static final String GRAPH_FILE = "widget-graph.png";
    static final String GRAPH_INFO = "widget-graph.json";
    static final String PREFS = "widgets";
    private static final int NOTE_MAX_CHARS = 3000;

    private Widgets() {
    }

    private static int[] ids(Context ctx, Class<?> provider) {
        return AppWidgetManager.getInstance(ctx).getAppWidgetIds(new ComponentName(ctx, provider));
    }

    static void updateAll(Context ctx) {
        updateTodo(ctx);
        for (int id : ids(ctx, NoteWidget.class)) NoteWidget.update(ctx, AppWidgetManager.getInstance(ctx), id);
        updateGraph(ctx);
    }

    // ------------------------------------------------------------------ things to do
    static void updateTodo(Context ctx) {
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        int[] ids = ids(ctx, TodoWidget.class);
        if (ids.length == 0) return;
        for (int id : ids) TodoWidget.update(ctx, m, id);
        m.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    /** "Today 15:00", "Tomorrow 09:00", or the date and the time. */
    static String when(Context ctx, long at) {
        Calendar now = Calendar.getInstance();
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(at);
        String time = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(at));
        int days = dayNumber(c) - dayNumber(now);
        if (days == 0) return ctx.getString(R.string.widget_today, time);
        if (days == 1) return ctx.getString(R.string.widget_tomorrow, time);
        return DateFormat.getDateInstance(DateFormat.MEDIUM).format(new Date(at)) + " " + time;
    }

    private static int dayNumber(Calendar c) {
        return c.get(Calendar.YEAR) * 400 + c.get(Calendar.DAY_OF_YEAR);
    }

    // ------------------------------------------------------------------ notes
    static synchronized void storeNotes(Context ctx, JSONObject p) throws JSONException {
        JSONObject all = readJson(new File(ctx.getFilesDir(), NOTES_FILE));
        JSONObject v = new JSONObject().put("name", p.optString("name", "")).put("graph", p.optString("graph", ""))
                .put("notes", p.optJSONArray("notes") != null ? p.optJSONArray("notes") : new JSONArray());
        all.put(p.optString("vault", ""), v);
        writeJson(new File(ctx.getFilesDir(), NOTES_FILE), all);
    }

    /** A note was saved: the note widgets showing it are drawn again. */
    static void noteChanged(Context ctx, String path) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        for (int id : ids(ctx, NoteWidget.class)) {
            if (path.equals(prefs.getString("note." + id, ""))) NoteWidget.update(ctx, m, id);
        }
    }

    /** The text of a note for a widget: no front matter, tasks as boxes, headings without "#". */
    static String noteText(String path) {
        File f = new File(path);
        if (!f.isFile()) return null;
        String text;
        try {
            byte[] b = java.nio.file.Files.readAllBytes(f.toPath());
            text = new String(b, 0, Math.min(b.length, 64 * 1024), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
        if (text.startsWith("---\n")) {
            int end = text.indexOf("\n---", 4);
            if (end > 0) text = text.substring(Math.min(text.length(), end + 4)).replaceFirst("^\\s*\\n", "");
        }
        StringBuilder out = new StringBuilder();
        boolean first = true;
        for (String line : text.split("\n", -1)) {
            String l = line.replaceAll("\\s*\\(@\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{1,2}:\\d{2})?\\)", "")
                    .replaceAll("<span style=\"color:[^\"]*\">([^<]*)</span>", "$1");
            if (first && l.matches("^#\\s+.*")) { first = false; continue; } // the title is the widget's own title
            first = false;
            l = l.replaceFirst("^(\\s*)[-*+]\\s+\\[[xX]\\]\\s+", "$1☑ ")
                    .replaceFirst("^(\\s*)[-*+]\\s+\\[ \\]\\s+", "$1☐ ")
                    .replaceFirst("^(\\s*)[-*+]\\s+", "$1• ")
                    .replaceFirst("^#{1,6}\\s+", "")
                    .replaceAll("\\*\\*([^*]+)\\*\\*", "$1").replaceAll("==([^=]+)==", "$1")
                    .replaceAll("!?\\[\\[([^\\]|]+)\\|([^\\]]+)\\]\\]", "$2").replaceAll("!?\\[\\[([^\\]]+)\\]\\]", "$1");
            out.append(l).append('\n');
            if (out.length() > NOTE_MAX_CHARS) break;
        }
        return out.toString().trim();
    }

    // ------------------------------------------------------------------ graph
    static void storeGraph(Context ctx, JSONObject p) throws NativeError, JSONException {
        byte[] png = Fs.unB64(p.optString("b64", ""));
        if (png.length == 0) return;
        Fs.writeAtomic(new File(ctx.getFilesDir(), GRAPH_FILE).getPath(), png, 0);
        writeJson(new File(ctx.getFilesDir(), GRAPH_INFO), new JSONObject().put("name", p.optString("name", "")).put("uri", p.optString("uri", "")));
        updateGraph(ctx);
    }

    static void updateGraph(Context ctx) {
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        int[] ids = ids(ctx, GraphWidget.class);
        if (ids.length == 0) return;
        JSONObject info = readJson(new File(ctx.getFilesDir(), GRAPH_INFO));
        File png = new File(ctx.getFilesDir(), GRAPH_FILE);
        Bitmap bmp = null;
        if (png.isFile()) {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = 1;
            bmp = BitmapFactory.decodeFile(png.getPath(), o);
        }
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_graph);
            v.setTextViewText(R.id.widget_title, info.optString("name", "").isEmpty() ? ctx.getString(R.string.widget_graph) : info.optString("name"));
            if (bmp != null) {
                v.setImageViewBitmap(R.id.widget_image, bmp);
                v.setViewVisibility(R.id.widget_image, View.VISIBLE);
                v.setViewVisibility(R.id.widget_empty, View.GONE);
            } else {
                v.setViewVisibility(R.id.widget_image, View.GONE);
                v.setViewVisibility(R.id.widget_empty, View.VISIBLE);
            }
            v.setOnClickPendingIntent(R.id.widget_root, Reminders.openLink(ctx, info.optString("uri", ""), 0x47000000 + id));
            m.updateAppWidget(id, v);
        }
    }

    // ------------------------------------------------------------------ files
    static JSONObject readJson(File f) {
        if (!f.isFile()) return new JSONObject();
        try {
            return new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "widget data unreadable: " + f.getName(), e);
            return new JSONObject();
        }
    }

    static void writeJson(File f, JSONObject o) {
        try {
            Fs.writeAtomic(f.getPath(), o.toString().getBytes(StandardCharsets.UTF_8), 0);
        } catch (NativeError e) {
            Log.w(TAG, "widget data not saved: " + f.getName(), e);
        }
    }
}
