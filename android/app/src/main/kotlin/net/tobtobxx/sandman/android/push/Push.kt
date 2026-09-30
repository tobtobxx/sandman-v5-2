package net.tobtobxx.sandman.android.push

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.suspendCancellableCoroutine
import net.tobtobxx.sandman.android.data.api.SandmanApi
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.UnifiedPush
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * Notifications when the app is closed, over UnifiedPush (docs/ANDROID.md). A distributor app the
 * user picks (e.g. ntfy) holds the connection; it gives us an endpoint and Web Push keys, the server
 * encrypts to them (src/push.ts), and [SandmanPushService] receives the decrypted message.
 */
class Push(
    private val context: Context,
    private val api: SandmanApi,
    val store: PushStore,
) {
    val state: Flow<PushState> = store.state

    /** The distributor in use, by app name, or null. */
    fun distributorName(): String? =
        UnifiedPush.getAckDistributor(context)?.let { pkg ->
            try {
                val pm = context.packageManager
                pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
            } catch (_: PackageManager.NameNotFoundException) {
                pkg
            }
        }

    /**
     * Picks a distributor (the user's default, or asks) and registers with the server's VAPID key.
     * Throws [java.io.IOException] if the server can't be reached for its key.
     */
    suspend fun enable(activity: Activity) {
        val key = api.pushKey().vapidPublicKey
        val picked =
            suspendCancellableCoroutine { cont ->
                UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { ok -> if (cont.isActive) cont.resume(ok) }
            }
        if (!picked) {
            store.setStatus(NO_DISTRIBUTOR)
            return
        }
        store.setEnabled(true)
        store.setStatus("Waiting for the distributor…")
        UnifiedPush.register(context, messageForDistributor = "Sandman", vapid = key)
    }

    /**
     * Registers again if push is on: at app start (recommended by UnifiedPush, in case the
     * distributor lost us) and after the server changes (new server, new VAPID key). The
     * distributor answers with [onNewEndpoint], which sends the endpoint to the server.
     */
    suspend fun refresh() {
        if (!store.current().enabled) return
        if (UnifiedPush.getAckDistributor(context) == null) {
            store.setStatus("The distributor app is gone. Turn notifications on again to pick another.")
            return
        }
        val key =
            try {
                api.pushKey().vapidPublicKey
            } catch (_: java.io.IOException) {
                return // offline or not configured: try at the next start
            }
        UnifiedPush.register(context, messageForDistributor = "Sandman", vapid = key)
    }

    suspend fun disable() {
        store.current().endpoint?.let { sync(REMOVE, it) }
        UnifiedPush.unregister(context)
        store.setEnabled(false)
        store.setEndpoint(null, null, null)
        store.setStatus(null)
    }

    suspend fun onNewEndpoint(
        url: String,
        p256dh: String,
        auth: String,
    ) {
        val old = store.current().endpoint
        if (old != null && old != url) sync(REMOVE, old)
        store.setEndpoint(url, p256dh, auth)
        store.setStatus("Registering with the server…")
        sync(ADD, url)
    }

    suspend fun onUnregistered() {
        store.current().endpoint?.let { sync(REMOVE, it) }
        store.setEnabled(false)
        store.setEndpoint(null, null, null)
        store.setStatus("The distributor ended the registration.")
    }

    suspend fun onRegistrationFailed(reason: FailedReason) {
        store.setStatus(
            when (reason) {
                FailedReason.NETWORK -> "The distributor has no network. Try again later."
                FailedReason.ACTION_REQUIRED -> "The distributor needs attention: open it, then try again."
                FailedReason.VAPID_REQUIRED -> "The distributor needs a server key. Update the server."
                FailedReason.INTERNAL_ERROR -> "The distributor failed to register. Try again."
            },
        )
    }

    /** Tells the server about an endpoint ([ADD]) or that it is gone ([REMOVE]), retrying offline. */
    private fun sync(
        action: String,
        endpoint: String,
    ) {
        val request =
            OneTimeWorkRequestBuilder<PushSyncWorker>()
                .setInputData(workDataOf(PushSyncWorker.ACTION to action, PushSyncWorker.ENDPOINT to endpoint))
                .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
        // APPEND_OR_REPLACE keeps the order: an old endpoint is removed before the new one is added.
        WorkManager.getInstance(context).enqueueUniqueWork("push-sync", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    companion object {
        const val ADD = "add"
        const val REMOVE = "remove"
        const val NO_DISTRIBUTOR =
            "No UnifiedPush distributor on this phone. Install one (e.g. ntfy from F-Droid or Play), then try again."
    }
}
