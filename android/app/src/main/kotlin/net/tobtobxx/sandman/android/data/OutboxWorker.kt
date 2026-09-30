package net.tobtobxx.sandman.android.data

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import net.tobtobxx.sandman.android.SandmanApp
import net.tobtobxx.sandman.android.data.api.ApiException
import net.tobtobxx.sandman.android.data.api.NotConfiguredException
import java.io.IOException

/**
 * Sends every pending capture, oldest first. Network trouble and server errors retry with backoff;
 * a rejected capture (4xx) is marked failed; a wrong token or missing settings stop the run and
 * leave captures pending until [Outbox.flush] is called again.
 */
class OutboxWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as SandmanApp).container
        val dao = container.outbox.dao
        for (capture in dao.pending()) {
            try {
                val result = container.api.send(capture.text, capture.clientMsgId)
                dao.markSent(capture.clientMsgId, result.sendId)
            } catch (e: NotConfiguredException) {
                return Result.failure()
            } catch (e: ApiException) {
                when {
                    e.status == 401 -> return Result.failure()
                    e.status >= 500 -> return Result.retry()
                    else -> dao.mark(capture.clientMsgId, OutboxCapture.FAILED, e.message)
                }
            } catch (e: IOException) {
                return Result.retry()
            }
        }
        return Result.success()
    }
}
