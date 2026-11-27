// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/** Widget of the things to do: every reminder of the notes, with its date (TodoWidgetService draws the rows). */
public final class TodoWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager m, int[] ids) {
        for (int id : ids) update(ctx, m, id);
        m.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    static void update(Context ctx, AppWidgetManager m, int id) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_todo);
        Intent svc = new Intent(ctx, TodoWidgetService.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME))); // one list per widget
        v.setRemoteAdapter(R.id.widget_list, svc);
        v.setEmptyView(R.id.widget_list, R.id.widget_empty);
        // a row: its own sknotes:// link is filled into this template
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("sknotes://open"), ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (android.os.Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        v.setPendingIntentTemplate(R.id.widget_list, PendingIntent.getActivity(ctx, 0x54000000 + id, open, flags));
        String list = Reminders.listLink(ctx);
        v.setOnClickPendingIntent(R.id.widget_header, Reminders.openLink(ctx, list, 0x55000000 + id));
        v.setOnClickPendingIntent(R.id.widget_empty, Reminders.openLink(ctx, list, 0x56000000 + id));
        m.updateAppWidget(id, v);
    }
}
