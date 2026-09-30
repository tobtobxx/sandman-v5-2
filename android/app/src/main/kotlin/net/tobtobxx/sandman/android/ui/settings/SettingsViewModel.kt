package net.tobtobxx.sandman.android.ui.settings

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import net.tobtobxx.sandman.android.AppContainer
import net.tobtobxx.sandman.android.data.ServerSettings
import net.tobtobxx.sandman.android.data.api.ApiException
import net.tobtobxx.sandman.android.push.PushState
import java.io.IOException

class SettingsViewModel(
    private val container: AppContainer,
) : ViewModel() {
    private val _loaded = MutableStateFlow<ServerSettings?>(null)
    val loaded: StateFlow<ServerSettings?> = _loaded.asStateFlow()

    private val _status = MutableStateFlow<String?>(null)
    val status: StateFlow<String?> = _status.asStateFlow()

    val push: StateFlow<PushState> =
        container.push.state.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PushState())

    private val _pushMessage = MutableStateFlow<String?>(null)

    /** The outcome of the last button press in the notifications section. */
    val pushMessage: StateFlow<String?> = _pushMessage.asStateFlow()

    fun distributorName(): String? = container.push.distributorName()

    init {
        viewModelScope.launch { _loaded.value = container.settings.current() }
    }

    /** Saves, checks the connection with `GET /home`, and sends anything waiting in the outbox. */
    fun save(settings: ServerSettings) {
        viewModelScope.launch {
            container.settings.save(settings)
            _status.value = "Checking…"
            _status.value =
                try {
                    container.api.home()
                    container.outbox.flush()
                    container.push.refresh() // a new server needs the endpoint, and has its own key
                    "Connected"
                } catch (e: ApiException) {
                    if (e.status == 401) "Wrong token" else "Server error: ${e.message}"
                } catch (e: IOException) {
                    "Can't reach the server: ${e.message}"
                }
        }
    }

    fun enablePush(activity: Activity) {
        viewModelScope.launch {
            _pushMessage.value = null
            _pushMessage.value =
                try {
                    container.push.enable(activity)
                    null
                } catch (e: IOException) {
                    "Can't get the server's push key: ${e.message}"
                }
        }
    }

    fun disablePush() {
        viewModelScope.launch {
            container.push.disable()
            _pushMessage.value = null
        }
    }

    fun testPush() {
        viewModelScope.launch {
            _pushMessage.value = "Sending…"
            _pushMessage.value =
                try {
                    val results = container.api.testPush().results
                    when {
                        results.isEmpty() -> "The server has no registered devices."
                        results.all { it.ok } -> "Sent to ${results.size} device(s)."
                        else -> "Failed: " + results.filter { !it.ok }.joinToString { it.error ?: it.id }
                    }
                } catch (e: IOException) {
                    "Can't reach the server: ${e.message}"
                }
        }
    }
}
