package net.tobtobxx.sandman.android.push

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import net.tobtobxx.sandman.android.SandmanApp
import net.tobtobxx.sandman.android.data.api.ApiException
import net.tobtobxx.sandman.android.data.api.NotConfiguredException
import java.io.IOException

/**
 * Sends the push endpoint to the server (`POST /push-subscriptions`) or removes it
 * (`DELETE /push-subscriptions`). Network trouble and server errors retry with backoff.
 */
class PushSyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as SandmanApp).container
        val store = container.push.store
        val endpoint = inputData.getString(ENDPOINT) ?: return Result.failure()
        try {
            if (inputData.getString(ACTION) == Push.REMOVE) {
                container.api.removePushSubscription(endpoint)
                return Result.success()
            }
            val state = store.current()
            // superseded by a newer endpoint, or turned off since
            if (state.endpoint != endpoint || state.p256dh == null || state.auth == null) return Result.success()
            container.api.addPushSubscription(endpoint, state.p256dh, state.auth)
            store.setStatus("On")
            return Result.success()
        } catch (e: NotConfiguredException) {
            store.setStatus("Set the server address, then turn notifications on.")
            return Result.failure()
        } catch (e: ApiException) {
            if (e.status >= 500) return Result.retry()
            if (inputData.getString(ACTION) !=
                Push.REMOVE
            ) {
                store.setStatus("The server refused the registration: ${e.message}")
            }
            return Result.failure()
        } catch (e: IOException) {
            return Result.retry()
        }
    }

    companion object {
        const val ACTION = "action"
        const val ENDPOINT = "endpoint"
    }
}
