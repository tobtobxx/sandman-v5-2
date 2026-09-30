package net.tobtobxx.sandman.android.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import net.tobtobxx.sandman.android.data.ServerSettings
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

val SandmanJson =
    Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

/** The server answered with an error status. `status` 401 means the token is wrong. */
class ApiException(
    val status: Int,
    message: String,
) : IOException(message)

/** Not configured yet: no server URL in settings. */
class NotConfiguredException : IOException("Set the server address in settings")

/** The routes of docs/API.md the app uses. Network errors surface as [IOException]. */
class SandmanApi(
    private val http: OkHttpClient,
    private val settings: suspend () -> ServerSettings,
) {
    suspend fun send(
        text: String,
        clientMsgId: String,
    ): SendResult = post("/send", SandmanJson.encodeToString(SendRequest(text, clientMsgId)))

    suspend fun home(): Home = get("/home")

    private suspend inline fun <reified T> get(path: String): T = call(request(path).get().build())

    private suspend inline fun <reified T> post(
        path: String,
        json: String,
    ): T = call(request(path).post(json.toRequestBody(JSON)).build())

    private suspend fun request(path: String): Request.Builder {
        val s = settings()
        if (!s.isConfigured) throw NotConfiguredException()
        return Request.Builder().url(s.baseUrl + path).apply {
            if (s.token.isNotEmpty()) header("Authorization", "Bearer ${s.token}")
        }
    }

    private suspend inline fun <reified T> call(request: Request): T =
        withContext(Dispatchers.IO) {
            http.newCall(request).execute().use { res ->
                val body = res.body.string()
                if (!res.isSuccessful) throw ApiException(res.code, errorText(body) ?: "HTTP ${res.code}")
                SandmanJson.decodeFromString<T>(body)
            }
        }

    // Errors come as {"error": "..."}, except 401, which is plain text.
    private fun errorText(body: String): String? =
        runCatching { SandmanJson.decodeFromString<ErrorBody>(body).error }.getOrNull()
            ?: body.takeIf { it.isNotBlank() && it.length < 200 }

    @kotlinx.serialization.Serializable
    private data class ErrorBody(
        val error: String,
    )

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}
