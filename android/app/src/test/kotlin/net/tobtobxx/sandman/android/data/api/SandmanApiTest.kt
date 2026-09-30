package net.tobtobxx.sandman.android.data.api

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import net.tobtobxx.sandman.android.data.ServerSettings
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class SandmanApiTest {
    private val server = MockWebServer()
    private lateinit var api: SandmanApi

    @Before
    fun setUp() {
        server.start()
        val base = server.url("/").toString().trimEnd('/')
        api = SandmanApi(OkHttpClient()) { ServerSettings(base, "secret") }
    }

    @After
    fun tearDown() = server.close()

    private fun reply(
        body: String,
        code: Int = 200,
    ) = server.enqueue(
        MockResponse
            .Builder()
            .code(code)
            .body(body)
            .build(),
    )

    @Test
    fun sendPostsTextWithIdAndToken() =
        runTest {
            reply(
                """{"send_id":"cap_1","items":[{"item_id":"itm_1","quote":"buy seeds","topic_id":"top_1",
                   "topic_title":"Garden","topic_kind":"subject","created":false,"confidence":"high"}]}""",
            )

            val result = api.send("buy seeds", "m-1")

            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/send", request.url.encodedPath)
            assertEquals("Bearer secret", request.headers["Authorization"])
            val body = Json.parseToJsonElement(request.body!!.utf8()).jsonObject
            assertEquals("buy seeds", body["text"]!!.jsonPrimitive.content)
            assertEquals("m-1", body["client_msg_id"]!!.jsonPrimitive.content)
            assertEquals("cap_1", result.sendId)
            assertFalse(result.pending)
            assertEquals("Garden", result.items.single().topicTitle)
        }

    @Test
    fun sendParsesPendingReply() =
        runTest {
            reply("""{"send_id":"cap_2","pending":true,"items":[]}""")

            val result = api.send("x", "m-2")

            assertTrue(result.pending)
            assertTrue(result.items.isEmpty())
        }

    @Test
    fun homeParsesTheApiExample() =
        runTest {
            reply(
                """{"now":"Tuesday 29 September · 08:14",
                   "needs_you":[{"id":"qst_1","text":"Which bank?","topic_id":"top_1","topic_title":"Taxes"}],
                   "finished":[{"card_id":"crd_1","title":"Drip kits","summary":"Three options","topic_id":"top_2","topic_title":"Garden"}],
                   "needs_you_count":2,"review_count":1}""",
            )

            val home = api.home()

            assertEquals("Which bank?", home.needsYou.single().text)
            assertEquals("Drip kits", home.finished.single().title)
            assertEquals(2, home.needsYouCount)
        }

    @Test
    fun errorsCarryStatusAndServerMessage() =
        runTest {
            reply("unauthorized", code = 401)
            try {
                api.home()
                fail("expected ApiException")
            } catch (e: ApiException) {
                assertEquals(401, e.status)
                assertEquals("unauthorized", e.message)
            }

            reply("""{"error":"empty message"}""", code = 400)
            try {
                api.send("", "m-3")
                fail("expected ApiException")
            } catch (e: ApiException) {
                assertEquals(400, e.status)
                assertEquals("empty message", e.message)
            }
        }

    @Test
    fun notConfiguredFailsWithoutARequest() =
        runTest {
            val unconfigured = SandmanApi(OkHttpClient()) { ServerSettings() }
            try {
                unconfigured.home()
                fail("expected NotConfiguredException")
            } catch (_: NotConfiguredException) {
            }
            assertEquals(0, server.requestCount)
        }
}
