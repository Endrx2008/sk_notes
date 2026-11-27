// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Placing a note widget: which note it shows. The list comes from the page (the notes of the vaults
 * opened in sk_notes, encrypted ones left out); a field above it narrows the list.
 */
public final class NoteWidgetConfig extends Activity {
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private final List<String[]> all = new ArrayList<>(); // [label, path, uri]
    private final List<String[]> shown = new ArrayList<>();
    private ArrayAdapter<String> adapter;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setResult(RESULT_CANCELED); // backing out does not place the widget
        Bundle extras = getIntent().getExtras();
        if (extras != null) widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return; }

        JSONObject store = Widgets.readJson(new File(getFilesDir(), Widgets.NOTES_FILE));
        JSONArray vaults = store.names();
        int count = vaults == null ? 0 : vaults.length();
        for (int i = 0; i < count; i++) {
            JSONObject v = store.optJSONObject(vaults.optString(i));
            if (v == null || !new File(vaults.optString(i)).isDirectory()) continue;
            JSONArray notes = v.optJSONArray("notes");
            for (int k = 0; notes != null && k < notes.length(); k++) {
                JSONObject n = notes.optJSONObject(k);
                if (n == null) continue;
                String label = (count > 1 ? v.optString("name", "") + " › " : "") + n.optString("name", "");
                all.add(new String[] { label, n.optString("path", ""), n.optString("uri", ""), n.optString("name", "") });
            }
        }

        int pad = dp(16);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.rgb(13, 13, 13));
        box.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText(R.string.widget_note_choose);
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setPadding(0, 0, 0, dp(10));
        box.addView(title);
        if (all.isEmpty()) {
            TextView none = new TextView(this);
            none.setText(R.string.widget_note_empty);
            none.setTextColor(Color.rgb(180, 180, 180));
            none.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
            box.addView(none);
            setContentView(box);
            return;
        }
        EditText filter = new EditText(this);
        filter.setHint(R.string.widget_note_filter);
        filter.setSingleLine(true);
        filter.setTextColor(Color.WHITE);
        filter.setHintTextColor(Color.rgb(130, 130, 130));
        box.addView(filter, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        ListView list = new ListView(this);
        adapter = new ArrayAdapter<String>(this, android.R.layout.simple_list_item_1, new ArrayList<String>()) {
            @Override
            public View getView(int position, View convert, ViewGroup parent) {
                View row = super.getView(position, convert, parent);
                ((TextView) row).setTextColor(Color.WHITE);
                return row;
            }
        };
        list.setAdapter(adapter);
        box.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        filter.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { show(s.toString()); }
            @Override public void afterTextChanged(Editable s) { }
        });
        list.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                choose(shown.get(position));
            }
        });
        show("");
        setContentView(box);
    }

    private void show(String q) {
        String needle = q.trim().toLowerCase();
        shown.clear();
        List<String> labels = new ArrayList<>();
        for (String[] n : all) {
            if (!needle.isEmpty() && !n[0].toLowerCase().contains(needle)) continue;
            shown.add(n);
            labels.add(n[0]);
        }
        adapter.clear();
        adapter.addAll(labels);
        adapter.notifyDataSetChanged();
    }

    private void choose(String[] n) {
        getSharedPreferences(Widgets.PREFS, MODE_PRIVATE).edit()
                .putString("note." + widgetId, n[1]).putString("note-uri." + widgetId, n[2]).putString("note-name." + widgetId, n[3]).apply();
        NoteWidget.update(this, AppWidgetManager.getInstance(this), widgetId);
        setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        finish();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
