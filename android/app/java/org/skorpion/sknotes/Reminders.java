// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The reminders of the notes: "(@2026-11-28 15:00)" on a line (see web features/reminders.js).
 * The page hands over every reminder of the open vault; they are kept per vault in
 * files/reminders.json, so that the alarms of all vaults survive a restart of the phone
 * (ReminderReceiver sets them again) and the widget of the things to do lists them all.
 * Each alarm posts a notification; a tap on it opens the note at the line (a sknotes:// link).
 */
final class Reminders {
    private static final String TAG = "sk_notes";
    static final String ACTION = "org.skorpion.sknotes.REMINDER";
    static final String CHANNEL = "reminders";
    private static final String FILE = "reminders.json";
    private static final String PREFS = "reminders";
    private static final int MAX_ALARMS = 400;

    private Reminders() {
    }

    // ------------------------------------------------------------------ the store
    static synchronized JSONObject load(Context ctx) {
        File f = new File(ctx.getFilesDir(), FILE);
        if (!f.isFile()) return new JSONObject();
        try {
            return new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "reminders unreadable", e);
            return new JSONObject();
        }
    }

    private static synchronized void save(Context ctx, JSONObject all) {
        try {
            Fs.writeAtomic(new File(ctx.getFilesDir(), FILE).getPath(), all.toString().getBytes(StandardCharsets.UTF_8), 0);
        } catch (NativeError e) {
            Log.w(TAG, "reminders not saved", e);
        }
    }

    /** The reminders of one vault, as the page sent them: {name, list, items: [{at, text, note, path, uri}]}. */
    static void store(Context ctx, String vault, JSONObject p) throws JSONException {
        if (vault.isEmpty()) return;
        JSONObject all = load(ctx);
        JSONObject v = new JSONObject();
        v.put("name", p.optString("name", ""));
        v.put("list", p.optString("list", ""));
        v.put("items", p.optJSONArray("items") != null ? p.optJSONArray("items") : new JSONArray());
        all.put(vault, v);
        save(ctx, all);
        schedule(ctx);
        Widgets.updateTodo(ctx);
    }

    /** Every reminder of every vault, the earliest first: [{at, text, note, path, uri, vault}]. */
    static List<JSONObject> all(Context ctx) {
        JSONObject store = load(ctx);
        List<JSONObject> out = new ArrayList<>();
        JSONArray names = store.names();
        for (int i = 0; names != null && i < names.length(); i++) {
            String vault = names.optString(i);
            JSONObject v = store.optJSONObject(vault);
            if (v == null) continue;
            if (!new File(vault).isDirectory()) continue; // a vault deleted or on a card taken out
            JSONArray items = v.optJSONArray("items");
            for (int k = 0; items != null && k < items.length(); k++) {
                JSONObject it = items.optJSONObject(k);
                if (it == null) continue;
                try {
                    it.put("vault", v.optString("name", ""));
                } catch (JSONException ignored) {
                    // keep it without the vault name
                }
                out.add(it);
            }
        }
        out.sort((a, b) -> Long.compare(a.optLong("at"), b.optLong("at")));
        return out;
    }

    /** The link of the list of things to do of the most recent vault with reminders (the widget's title). */
    static String listLink(Context ctx) {
        JSONObject store = load(ctx);
        JSONArray names = store.names();
        for (int i = 0; names != null && i < names.length(); i++) {
            JSONObject v = store.optJSONObject(names.optString(i));
            if (v != null && !v.optString("list", "").isEmpty()) return v.optString("list");
        }
        return "";
    }

    // ------------------------------------------------------------------ alarms
    private static int code(JSONObject it) {
        return (it.optString("uri", "") + "|" + it.optLong("at") + "|" + it.optString("text", "")).hashCode();
    }

    private static PendingIntent alarmIntent(Context ctx, JSONObject it, int code) {
        Intent i = new Intent(ctx, ReminderReceiver.class).setAction(ACTION)
                .putExtra("at", it.optLong("at"))
                .putExtra("text", it.optString("text", ""))
                .putExtra("note", it.optString("note", ""))
                .putExtra("vault", it.optString("vault", ""))
                .putExtra("uri", it.optString("uri", ""))
                .putExtra("code", code);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Set an alarm for each reminder still to come (and take away the alarms of reminders gone). */
    static synchronized void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> before = new HashSet<>(prefs.getStringSet("codes", new HashSet<String>()));
        Set<String> now = new HashSet<>();
        long t = System.currentTimeMillis();
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        int n = 0;
        for (JSONObject it : all(ctx)) {
            long at = it.optLong("at");
            if (at <= t) continue;
            if (n++ >= MAX_ALARMS) break;
            int c = code(it);
            now.add(String.valueOf(c));
            PendingIntent pi = alarmIntent(ctx, it, c);
            try {
                if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi); // a few minutes late at most
            } catch (SecurityException e) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        }
        for (String old : before) {
            if (now.contains(old)) continue;
            int c = Integer.parseInt(old);
            Intent i = new Intent(ctx, ReminderReceiver.class).setAction(ACTION);
            PendingIntent pi = PendingIntent.getBroadcast(ctx, c, i, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }
        }
        prefs.edit().putStringSet("codes", now).apply();
    }

    // ------------------------------------------------------------------ notifications
    static boolean canNotify(Context ctx) {
        if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        return nm != null && nm.areNotificationsEnabled();
    }

    static void channel(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, ctx.getString(R.string.reminders_channel), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(ctx.getString(R.string.reminders_channel_desc));
        ch.enableVibration(true);
        nm.createNotificationChannel(ch);
    }

    /** The intent that opens sk_notes on a sknotes:// link (the note of a reminder, a list, the graph). */
    static PendingIntent openLink(Context ctx, String uri, int code) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(uri.isEmpty() ? "sknotes://open" : uri), ctx, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void notify(Context ctx, Intent data) {
        if (!canNotify(ctx)) return;
        channel(ctx);
        String text = data.getStringExtra("text");
        String note = data.getStringExtra("note");
        String uri = data.getStringExtra("uri");
        int code = data.getIntExtra("code", 0);
        String title = text == null || text.isEmpty() ? (note == null ? "sk_notes" : note) : text;
        String body = note == null ? "" : note;
        Notification n = new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("⏰ " + title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setWhen(data.getLongExtra("at", System.currentTimeMillis()))
                .setShowWhen(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setColor(0xFFE05C00)
                .setContentIntent(openLink(ctx, uri == null ? "" : uri, code))
                .build();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(code, n);
    }
}
