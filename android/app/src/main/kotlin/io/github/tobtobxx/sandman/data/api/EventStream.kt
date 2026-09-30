package io.github.tobtobxx.sandman.data.api

import io.github.tobtobxx.sandman.data.ServerSettings
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.retryWhen
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * `GET /events/stream` as a Flow. Collect it only while something is on screen: it holds a
 * connection open. Starts from "now" (`after=-1`) and resumes after the last seen id on reconnect.
 */
class EventStream(
    http: OkHttpClient,
    private val settings: suspend () -> ServerSettings,
) {
    // The server pings every 20 s; a minute of silence means the connection is dead.
    private val sse = http.newBuilder().readTimeout(60, TimeUnit.SECONDS).build()

    fun events(): Flow<ServerEvent> {
        // Written on OkHttp's thread, read on reconnect.
        val lastId = AtomicLong(-1)
        return callbackFlow {
            val s = settings()
            if (!s.isConfigured) throw NotConfiguredException()
            val request =
                Request
                    .Builder()
                    .url("${s.baseUrl}/events/stream?after=${lastId.get()}")
                    .apply { if (s.token.isNotEmpty()) header("Authorization", "Bearer ${s.token}") }
                    .build()
            val source =
                EventSources.createFactory(sse).newEventSource(
                    request,
                    object : EventSourceListener() {
                        override fun onEvent(
                            eventSource: EventSource,
                            id: String?,
                            type: String?,
                            data: String,
                        ) {
                            val event =
                                runCatching { SandmanJson.decodeFromString<ServerEvent>(data) }.getOrNull() ?: return
                            lastId.set(event.id)
                            trySend(event)
                        }

                        override fun onClosed(eventSource: EventSource) {
                            close(IOException("event stream closed"))
                        }

                        override fun onFailure(
                            eventSource: EventSource,
                            t: Throwable?,
                            response: Response?,
                        ) {
                            close(t ?: IOException("event stream failed: HTTP ${response?.code}"))
                        }
                    },
                )
            awaitClose { source.cancel() }
        }.retryWhen { cause, attempt ->
            if (cause !is IOException || cause is NotConfiguredException) return@retryWhen false
            delay((1000L shl attempt.coerceAtMost(5).toInt()).coerceAtMost(30_000))
            true
        }
    }
}
