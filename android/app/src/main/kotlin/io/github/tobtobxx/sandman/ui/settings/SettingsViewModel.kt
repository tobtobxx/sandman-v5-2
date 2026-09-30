package io.github.tobtobxx.sandman.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.tobtobxx.sandman.AppContainer
import io.github.tobtobxx.sandman.data.ServerSettings
import io.github.tobtobxx.sandman.data.api.ApiException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException

class SettingsViewModel(
    private val container: AppContainer,
) : ViewModel() {
    private val _loaded = MutableStateFlow<ServerSettings?>(null)
    val loaded: StateFlow<ServerSettings?> = _loaded.asStateFlow()

    private val _status = MutableStateFlow<String?>(null)
    val status: StateFlow<String?> = _status.asStateFlow()

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
                    "Connected"
                } catch (e: ApiException) {
                    if (e.status == 401) "Wrong token" else "Server error: ${e.message}"
                } catch (e: IOException) {
                    "Can't reach the server: ${e.message}"
                }
        }
    }
}
