package net.tobtobxx.sandman.android.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.flow.Flow
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * A capture waiting to be sent, or already sent. [clientMsgId] makes `POST /send` idempotent, so a
 * retry after a lost reply never files the text twice.
 */
@Entity(tableName = "outbox")
data class OutboxCapture(
    @PrimaryKey val clientMsgId: String,
    val text: String,
    val createdAt: Long,
    val state: String = PENDING,
    val sendId: String? = null,
    val error: String? = null,
) {
    companion object {
        const val PENDING = "pending"
        const val SENT = "sent"
        const val FAILED = "failed"
    }
}

@Dao
interface OutboxDao {
    @Insert
    suspend fun insert(capture: OutboxCapture)

    @Query("SELECT * FROM outbox WHERE state = 'pending' ORDER BY createdAt")
    suspend fun pending(): List<OutboxCapture>

    @Query("SELECT * FROM outbox ORDER BY createdAt DESC LIMIT :limit")
    fun recent(limit: Int): Flow<List<OutboxCapture>>

    @Query("UPDATE outbox SET state = 'sent', sendId = :sendId, error = NULL WHERE clientMsgId = :id")
    suspend fun markSent(
        id: String,
        sendId: String,
    )

    @Query("UPDATE outbox SET state = :state, error = :error WHERE clientMsgId = :id")
    suspend fun mark(
        id: String,
        state: String,
        error: String?,
    )
}

@Database(entities = [OutboxCapture::class], version = 1)
abstract class AppDatabase : RoomDatabase() {
    abstract fun outbox(): OutboxDao
}

class Outbox(
    private val context: Context,
    val dao: OutboxDao,
) {
    val recent: Flow<List<OutboxCapture>> = dao.recent(20)

    suspend fun add(text: String) {
        dao.insert(OutboxCapture(UUID.randomUUID().toString(), text, System.currentTimeMillis()))
        flush()
    }

    suspend fun retry(capture: OutboxCapture) {
        dao.mark(capture.clientMsgId, OutboxCapture.PENDING, null)
        flush()
    }

    /** Sends pending captures when the network is up. Also call after the settings change. */
    fun flush() {
        val request =
            OneTimeWorkRequestBuilder<OutboxWorker>()
                .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
        // APPEND_OR_REPLACE: a capture added while a run is in progress still gets its own run.
        WorkManager
            .getInstance(context)
            .enqueueUniqueWork("outbox", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
}
