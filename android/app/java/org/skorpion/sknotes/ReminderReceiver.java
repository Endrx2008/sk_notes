// sk_notes for Android. Copyright (C) 2026 Enrico Miot. SPDX-License-Identifier: GPL-3.0-or-later
package org.skorpion.sknotes;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * An alarm of a reminder went off: the notification. After a restart of the phone, an update of
 * the app or a change of the clock, the alarms are set again (Android forgets them).
 */
public final class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (Reminders.ACTION.equals(a)) {
            Reminders.notify(ctx, intent);
            Widgets.updateTodo(ctx); // the reminder moves to "late" in the widget
            return;
        }
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
                || "android.intent.action.TIME_SET".equals(a) || Intent.ACTION_TIMEZONE_CHANGED.equals(a)
                || "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED".equals(a)) {
            Reminders.schedule(ctx);
            Widgets.updateAll(ctx);
        }
    }
}
