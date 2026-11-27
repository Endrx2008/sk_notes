// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** The rows of the widget of the things to do: what to do, when, and in which note. */
public final class TodoWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Rows(getApplicationContext());
    }

    private static final class Rows implements RemoteViewsFactory {
        private final Context ctx;
        private List<JSONObject> items = new ArrayList<>();

        Rows(Context ctx) {
            this.ctx = ctx;
        }

        @Override
        public void onCreate() {
        }

        @Override
        public void onDataSetChanged() {
            // the ones of the last 24 hours stay (late, in red), older ones are gone
            long from = System.currentTimeMillis() - 24L * 3600 * 1000;
            List<JSONObject> out = new ArrayList<>();
            for (JSONObject it : Reminders.all(ctx)) if (it.optLong("at") >= from) out.add(it);
            items = out;
        }

        @Override
        public void onDestroy() {
            items.clear();
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public RemoteViews getViewAt(int i) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_todo_row);
            if (i < 0 || i >= items.size()) return v;
            JSONObject it = items.get(i);
            long at = it.optLong("at");
            String text = it.optString("text", "");
            String note = it.optString("note", "");
            v.setTextViewText(R.id.row_text, text.isEmpty() ? note : text);
            v.setTextViewText(R.id.row_when, Widgets.when(ctx, at));
            v.setTextColor(R.id.row_when, at < System.currentTimeMillis() ? 0xFFE5484D : 0xFFE05C00);
            v.setTextViewText(R.id.row_note, note);
            v.setOnClickFillInIntent(R.id.row_root, new Intent().setData(Uri.parse(it.optString("uri", "sknotes://open"))));
            return v;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int i) {
            return i < items.size() ? (items.get(i).optString("uri") + items.get(i).optLong("at")).hashCode() : i;
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }
    }
}
