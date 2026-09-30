package net.tobtobxx.sandman.android

import android.content.Context
import androidx.room.Room
import net.tobtobxx.sandman.android.data.AppDatabase
import net.tobtobxx.sandman.android.data.Outbox
import net.tobtobxx.sandman.android.data.SettingsStore
import net.tobtobxx.sandman.android.data.api.EventStream
import net.tobtobxx.sandman.android.data.api.SandmanApi
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Manual dependency injection: every long-lived object is created here, once. */
class AppContainer(
    context: Context,
) {
    val settings = SettingsStore(context)

    // /send waits until the capture is filed, which takes a model call or two.
    private val http =
        OkHttpClient
            .Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build()

    val api = SandmanApi(http) { settings.current() }

    val events = EventStream(http) { settings.current() }

    private val db = Room.databaseBuilder(context, AppDatabase::class.java, "sandman.db").build()

    val outbox = Outbox(context, db.outbox())
}
