package io.github.tobtobxx.sandman.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.tobtobxx.sandman.AppContainer
import io.github.tobtobxx.sandman.data.OutboxCapture
import io.github.tobtobxx.sandman.data.api.ApiException
import io.github.tobtobxx.sandman.data.api.Home
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

data class HomeState(
    val home: Home? = null,
    val error: String? = null,
    val configured: Boolean = true,
)

class HomeViewModel(
    private val container: AppContainer,
) : ViewModel() {
    private val _state = MutableStateFlow(HomeState())
    val state: StateFlow<HomeState> = _state.asStateFlow()

    val sent: StateFlow<List<OutboxCapture>> =
        container.outbox.recent.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun send(text: String) {
        if (text.isBlank()) return
        viewModelScope.launch { container.outbox.add(text.trim()) }
    }

    fun retry(capture: OutboxCapture) {
        viewModelScope.launch { container.outbox.retry(capture) }
    }

    suspend fun refresh() {
        val configured = container.settings.current().isConfigured
        if (!configured) {
            _state.update { it.copy(configured = false, error = null) }
            return
        }
        try {
            val home = container.api.home()
            _state.update { HomeState(home = home) }
        } catch (e: ApiException) {
            _state.update { it.copy(error = if (e.status == 401) "Wrong token" else e.message, configured = true) }
        } catch (e: IOException) {
            _state.update { it.copy(error = "Can't reach the server: ${e.message}", configured = true) }
        }
    }

    /** Refresh now and after every server event. Call while the screen is visible. */
    @OptIn(FlowPreview::class)
    suspend fun follow() {
        refresh()
        if (!container.settings.current().isConfigured) return
        container.events
            .events()
            .debounce(300)
            .catch { }
            .collect { refresh() }
    }
}
