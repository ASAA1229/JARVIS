package com.jarvis.companion

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
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Free approval alerts without Firebase or a paid push service: WorkManager polls the
 * laptop (minimum Android interval, 15 minutes) over the signed API and posts a local
 * notification when new approvals are waiting. The notification never contains the
 * directive text; the owner opens the app to review and approve.
 */
class ApprovalPollWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val session = CompanionSession(applicationContext)
        if (!session.enrolled || !session.notificationsEnabled || !session.keys.hasIdentity()) return Result.success()
        return try {
            val client = session.connect()
            val pending = session.guard { client.pendingApprovals() }
            val known = session.notifiedApprovals
            val fresh = pending.filter { it.approvalId !in known }
            if (fresh.isNotEmpty()) notify(pending.size)
            session.notifiedApprovals = known + fresh.map { it.approvalId }
            Result.success()
        } catch (_: SessionRevokedException) {
            // Local identity already wiped by guard(); stop polling.
            Result.success()
        } catch (_: Exception) {
            // Laptop unreachable or asleep: try again on the next period, never spin.
            Result.retry()
        }
    }

    private fun notify(count: Int) {
        val context = applicationContext
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "JARVIS approvals", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val open = PendingIntent.getActivity(context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = if (count == 1) "1 action is waiting for your approval." else "$count actions are waiting for your approval."
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("JARVIS needs approval")
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
    }

    companion object {
        private const val CHANNEL = "jarvis_approvals"
        private const val NOTIFICATION_ID = 1001
        private const val WORK_NAME = "jarvis-approval-poll"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ApprovalPollWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}
