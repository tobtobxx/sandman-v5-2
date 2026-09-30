package net.tobtobxx.sandman.android

import android.app.Application
import net.tobtobxx.sandman.android.push.Notifications

class SandmanApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        Notifications.createChannels(this)
    }
}
