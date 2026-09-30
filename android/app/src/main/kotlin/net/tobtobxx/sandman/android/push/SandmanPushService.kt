package net.tobtobxx.sandman.android.push

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import net.tobtobxx.sandman.android.SandmanApp
import net.tobtobxx.sandman.android.data.api.PushNotice
import net.tobtobxx.sandman.android.data.api.SandmanJson
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** Receives endpoints and messages from the UnifiedPush distributor. */
class SandmanPushService : PushService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val push get() = (application as SandmanApp).container.push

    override fun onNewEndpoint(
        endpoint: PushEndpoint,
        instance: String,
    ) {
        val keys = endpoint.pubKeySet
        if (keys == null) {
            // Every distributor since UnifiedPush 2 gives keys; the server can't encrypt without them.
            scope.launch { push.store.setStatus("The distributor is too old for encrypted messages. Update it.") }
            return
        }
        scope.launch { push.onNewEndpoint(endpoint.url, keys.pubKey, keys.auth) }
    }

    override fun onMessage(
        message: PushMessage,
        instance: String,
    ) {
        if (!message.decrypted) return
        val notice =
            runCatching { SandmanJson.decodeFromString<PushNotice>(message.content.decodeToString()) }.getOrNull()
                ?: return
        // While the app is on screen it follows the event stream; a test is always shown.
        val visible =
            ProcessLifecycleOwner
                .get()
                .lifecycle.currentState
                .isAtLeast(Lifecycle.State.STARTED)
        if (visible && notice.type != Notifications.TEST) return
        Notifications.show(this, notice)
    }

    override fun onRegistrationFailed(
        reason: FailedReason,
        instance: String,
    ) {
        scope.launch { push.onRegistrationFailed(reason) }
    }

    override fun onUnregistered(instance: String) {
        scope.launch { push.onUnregistered() }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
