package net.tobtobxx.sandman.android.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Shapes from docs/API.md. Only the fields the app uses; unknown keys are ignored.

@Serializable
data class SendRequest(
    val text: String,
    @SerialName("client_msg_id") val clientMsgId: String,
    @SerialName("client_id") val clientId: String = "android",
    val source: String = "text",
)

@Serializable
data class SendResult(
    @SerialName("send_id") val sendId: String,
    val pending: Boolean = false,
    val items: List<SendItem> = emptyList(),
)

@Serializable
data class SendItem(
    @SerialName("item_id") val itemId: String,
    val quote: String,
    @SerialName("topic_id") val topicId: String,
    @SerialName("topic_title") val topicTitle: String? = null,
    val created: Boolean = false,
)

@Serializable
data class Home(
    val now: String = "",
    @SerialName("needs_you") val needsYou: List<NeedsYou> = emptyList(),
    val finished: List<Finished> = emptyList(),
    @SerialName("needs_you_count") val needsYouCount: Int = 0,
    @SerialName("review_count") val reviewCount: Int = 0,
)

@Serializable
data class NeedsYou(
    val id: String,
    val text: String,
    @SerialName("topic_id") val topicId: String? = null,
    @SerialName("topic_title") val topicTitle: String? = null,
)

@Serializable
data class Finished(
    @SerialName("card_id") val cardId: String,
    val title: String,
    val summary: String? = null,
    @SerialName("topic_title") val topicTitle: String? = null,
)

/** One row of the server's event log, as sent on `/events/stream`. */
@Serializable
data class ServerEvent(
    val id: Long,
    val type: String,
    @SerialName("ref_id") val refId: String? = null,
)
