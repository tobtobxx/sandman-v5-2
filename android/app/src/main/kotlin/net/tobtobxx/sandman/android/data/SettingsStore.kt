package net.tobtobxx.sandman.android.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** Where the Sandman server is, e.g. `http://sandman.tailnet.ts.net:8700`, and its `api.token`. */
data class ServerSettings(
    val baseUrl: String = "",
    val token: String = "",
) {
    val isConfigured get() = baseUrl.isNotBlank()
}

private val Context.dataStore by preferencesDataStore("settings")

class SettingsStore(
    private val context: Context,
) {
    private val baseUrlKey = stringPreferencesKey("base_url")
    private val tokenKey = stringPreferencesKey("token")

    val server: Flow<ServerSettings> =
        context.dataStore.data.map { ServerSettings(it[baseUrlKey].orEmpty(), it[tokenKey].orEmpty()) }

    suspend fun current(): ServerSettings = server.first()

    suspend fun save(settings: ServerSettings) {
        context.dataStore.edit {
            it[baseUrlKey] = settings.baseUrl.trim().trimEnd('/')
            it[tokenKey] = settings.token.trim()
        }
    }
}
