package io.github.tobtobxx.sandman

import android.app.Application

class SandmanApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
