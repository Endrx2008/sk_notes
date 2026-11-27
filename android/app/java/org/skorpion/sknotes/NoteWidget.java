// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

/** Widget of one note (chosen in NoteWidgetConfig when it is placed): its text; a tap opens the note. */
public final class NoteWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager m, int[] ids) {
        for (int id : ids) update(ctx, m, id);
    }

    @Override
    public void onDeleted(Context ctx, int[] ids) {
        SharedPreferences.Editor e = ctx.getSharedPreferences(Widgets.PREFS, Context.MODE_PRIVATE).edit();
        for (int id : ids) e.remove("note." + id).remove("note-name." + id).remove("note-uri." + id);
        e.apply();
    }

    static void update(Context ctx, AppWidgetManager m, int id) {
        SharedPreferences prefs = ctx.getSharedPreferences(Widgets.PREFS, Context.MODE_PRIVATE);
        String path = prefs.getString("note." + id, "");
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_note);
        if (path.isEmpty()) {
            v.setTextViewText(R.id.widget_title, ctx.getString(R.string.widget_note));
            v.setTextViewText(R.id.widget_text, ctx.getString(R.string.widget_note_none));
        } else {
            String name = prefs.getString("note-name." + id, "");
            v.setTextViewText(R.id.widget_title, name.contains("/") ? name.substring(name.lastIndexOf('/') + 1) : name);
            String text = Widgets.noteText(path);
            v.setTextViewText(R.id.widget_text, text == null ? ctx.getString(R.string.widget_note_missing) : text.isEmpty() ? "…" : text);
        }
        v.setOnClickPendingIntent(R.id.widget_root, Reminders.openLink(ctx, prefs.getString("note-uri." + id, ""), 0x4E000000 + id));
        m.updateAppWidget(id, v);
    }
}
