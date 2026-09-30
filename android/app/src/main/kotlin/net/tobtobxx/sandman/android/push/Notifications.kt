package net.tobtobxx.sandman.android.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import net.tobtobxx.sandman.android.MainActivity
import net.tobtobxx.sandman.android.R
import net.tobtobxx.sandman.android.data.api.PushNotice

/** Notification channels, one per kind of push, so each can be muted on its own in system settings. */
object Notifications {
    const val TEST = "push.test"
    const val EXTRA_TOPIC_ID = "topic_id"

    enum class Channel(
        val id: String,
        val title: String,
        val importance: Int,
    ) {
        QUESTIONS("questions", "Questions", NotificationManager.IMPORTANCE_HIGH),
        REMINDERS("reminders", "Reminders", NotificationManager.IMPORTANCE_HIGH),
        OTHER("other", "Other", NotificationManager.IMPORTANCE_DEFAULT),
    }

    /** The channel for a push: by the server's `kind` (the notifier level's key, DESIGN §6.12). */
    fun channelFor(notice: PushNotice): Channel =
        when (notice.kind) {
            "question" -> Channel.QUESTIONS
            "reminder" -> Channel.REMINDERS
            else -> Channel.OTHER
        }

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(Channel.entries.map { NotificationChannel(it.id, it.title, it.importance) })
    }

    /** Whether notifications can be shown (Android 13+ asks for permission; the user can also turn them off). */
    fun canNotify(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun show(
        context: Context,
        notice: PushNotice,
    ) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val open =
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_TOPIC_ID, notice.topicId)
        val tap =
            PendingIntent.getActivity(
                context,
                notice.id.toInt(),
                open,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val notification =
            NotificationCompat
                .Builder(context, channelFor(notice).id)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(notice.title)
                .setContentText(notice.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build()
        try {
            NotificationManagerCompat.from(context).notify(notice.id.toInt(), notification)
        } catch (_: SecurityException) {
            // permission revoked between the check and here
        }
    }
}
