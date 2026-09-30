package net.tobtobxx.sandman.android.push

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Push as the settings screen shows it. [endpoint] and its keys come from the distributor and are
 * what the server gets in `POST /push-subscriptions`.
 */
data class PushState(
    val enabled: Boolean = false,
    val endpoint: String? = null,
    val p256dh: String? = null,
    val auth: String? = null,
    val status: String? = null,
)

private val Context.pushStore by preferencesDataStore("push")

class PushStore(
    private val context: Context,
) {
    private val enabledKey = booleanPreferencesKey("enabled")
    private val endpointKey = stringPreferencesKey("endpoint")
    private val p256dhKey = stringPreferencesKey("p256dh")
    private val authKey = stringPreferencesKey("auth")
    private val statusKey = stringPreferencesKey("status")

    val state: Flow<PushState> =
        context.pushStore.data.map {
            PushState(it[enabledKey] ?: false, it[endpointKey], it[p256dhKey], it[authKey], it[statusKey])
        }

    suspend fun current(): PushState = state.first()

    suspend fun setEnabled(enabled: Boolean) = context.pushStore.edit { it[enabledKey] = enabled }

    suspend fun setStatus(status: String?) = context.pushStore.edit { it.put(statusKey, status) }

    suspend fun setEndpoint(
        endpoint: String?,
        p256dh: String?,
        auth: String?,
    ) = context.pushStore.edit {
        it.put(endpointKey, endpoint)
        it.put(p256dhKey, p256dh)
        it.put(authKey, auth)
    }

    private fun androidx.datastore.preferences.core.MutablePreferences.put(
        key: Preferences.Key<String>,
        value: String?,
    ) {
        if (value == null) remove(key) else this[key] = value
    }
}
