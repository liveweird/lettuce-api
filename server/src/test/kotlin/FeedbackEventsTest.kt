package ch.nokillswit

import ch.nokillswit.feedbacks.Feedback
import ch.nokillswit.feedbacks.FeedbackCreateRequest
import ch.nokillswit.feedbacks.FeedbackEventListResponse
import ch.nokillswit.feedbacks.FeedbackResponse
import ch.nokillswit.feedbacks.FeedbackContentUpdate
import ch.nokillswit.feedbacks.FeedbackEventType
import ch.nokillswit.feedbacks.FeedbackStatus
import ch.nokillswit.feedbacks.FeedbackVisibility
import ch.nokillswit.feedbacks.feedbackCreationEvent
import ch.nokillswit.feedbacks.feedbackExpiryEvent
import ch.nokillswit.feedbacks.feedbackUpdateEvent
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class FeedbackEventsTest {


    // ---- pure description helpers (no DB) ----

    @Test
    fun `creation descriptor carries the initial status`() {
        fun fb(status: FeedbackStatus) = Feedback(
            subjectId = 1u, providerId = 2u, visibility = FeedbackVisibility.PROVIDER_SUBJECT, status = status,
        )
        val draft = feedbackCreationEvent(fb(FeedbackStatus.DRAFT))
        assertEquals(FeedbackEventType.CREATED, draft.type)
        assertEquals(mapOf("status" to "DRAFT"), draft.params)
        assertEquals("REQUESTED", feedbackCreationEvent(fb(FeedbackStatus.REQUESTED)).params["status"])
    }

    @Test
    fun `update descriptor reports transitions, edits, or nothing`() {
        val base = Feedback(
            subjectId = 1u, providerId = 2u, visibility = FeedbackVisibility.PROVIDER_SUBJECT,
            status = FeedbackStatus.DRAFT, content = "a",
        )
        val sent = feedbackUpdateEvent(base, base.copy(status = FeedbackStatus.SENT))
        assertEquals(FeedbackEventType.STATUS_CHANGED, sent?.type)
        assertEquals(mapOf("from" to "DRAFT", "to" to "SENT"), sent?.params)

        assertEquals(FeedbackEventType.CONTENT_UPDATED, feedbackUpdateEvent(base, base.copy(content = "b"))?.type)

        val vis = feedbackUpdateEvent(base, base.copy(visibility = FeedbackVisibility.PUBLIC))
        assertEquals(FeedbackEventType.VISIBILITY_CHANGED, vis?.type)
        assertEquals(mapOf("to" to "PUBLIC"), vis?.params)

        assertEquals(
            FeedbackEventType.CONTENT_AND_VISIBILITY_UPDATED,
            feedbackUpdateEvent(base, base.copy(content = "b", visibility = FeedbackVisibility.PUBLIC))?.type,
        )
        assertNull(feedbackUpdateEvent(base, base.copy()))
    }

    @Test
    fun `expiry descriptor carries no params — the sentence carries no actor`() {
        val expiry = feedbackExpiryEvent()
        assertEquals(FeedbackEventType.REQUEST_EXPIRED, expiry.type)
        assertEquals(emptyMap(), expiry.params)
    }

    // ---- integration ----

    @Test
    fun `creating and transitioning a feedback records audit events against the actor`() = testApplication {
        usePostgresTestcontainer()
        val providerEmail = uniqueEmail("provider")
        val providerId = TestUsers.seed(email = providerEmail, password = "pw", name = "Paula", roles = emptySet())
        val subjectId = TestUsers.seed(email = uniqueEmail("subject"), password = "pw", roles = emptySet())
        val provider = authedClient(providerEmail, "pw")

        val created = provider.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    subjectId = subjectId, providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_SUBJECT,
                    status = FeedbackStatus.DRAFT, content = "draft",
                ),
            )
        }.body<FeedbackResponse>()

        // One event after creation, attributed to the provider with their resolved name.
        val afterCreate = provider.get("/api/v1/feedbacks/${created.id}/events").body<FeedbackEventListResponse>()
        assertEquals(1, afterCreate.items.size)
        val ev = afterCreate.items.single()
        assertEquals(FeedbackEventType.CREATED, ev.type)
        assertEquals(mapOf("status" to "DRAFT"), ev.params)
        assertEquals(providerId, ev.userId)
        assertEquals("Paula", ev.userName)

        // Sending it adds a status-change event, topping the newest-first list.
        assertEquals(
            HttpStatusCode.NoContent,
            provider.post("/api/v1/feedbacks/${created.id}/send").status,
        )
        val afterSend = provider.get("/api/v1/feedbacks/${created.id}/events").body<FeedbackEventListResponse>()
        assertEquals(2, afterSend.items.size)
        val sent = afterSend.items.first()
        assertEquals(FeedbackEventType.STATUS_CHANGED, sent.type)
        assertEquals(mapOf("from" to "DRAFT", "to" to "SENT"), sent.params)
    }

    @Test
    fun `editing content (same status) records a content event`() = testApplication {
        usePostgresTestcontainer()
        val providerEmail = uniqueEmail("provider")
        val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
        val subjectId = TestUsers.seed(email = uniqueEmail("subject"), password = "pw", roles = emptySet())
        val provider = authedClient(providerEmail, "pw")

        val created = provider.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    subjectId = subjectId, providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_SUBJECT,
                    status = FeedbackStatus.DRAFT, content = "first",
                ),
            )
        }.body<FeedbackResponse>()

        provider.put("/api/v1/feedbacks/${created.id}") {
            contentType(ContentType.Application.Json)
            setBody(FeedbackContentUpdate(content = "revised", visibility = FeedbackVisibility.PROVIDER_SUBJECT))
        }

        val events = provider.get("/api/v1/feedbacks/${created.id}/events").body<FeedbackEventListResponse>()
        assertEquals(
            listOf(FeedbackEventType.CONTENT_UPDATED, FeedbackEventType.CREATED),
            events.items.map { it.type },
        )
    }

    @Test
    fun `events are readable only by those who may read the feedback`() = testApplication {
        usePostgresTestcontainer()
        val providerEmail = uniqueEmail("provider")
        val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
        val subjectId = TestUsers.seed(email = uniqueEmail("subject"), password = "pw", roles = emptySet())
        val strangerEmail = uniqueEmail("stranger")
        TestUsers.seed(email = strangerEmail, password = "pw", roles = emptySet())
        val provider = authedClient(providerEmail, "pw")

        // A PROVIDER_SUBJECT draft: only provider/subject (and admins) may read it.
        val created = provider.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    subjectId = subjectId, providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_SUBJECT,
                    status = FeedbackStatus.DRAFT, content = "secret",
                ),
            )
        }.body<FeedbackResponse>()

        assertEquals(
            HttpStatusCode.OK,
            provider.get("/api/v1/feedbacks/${created.id}/events").status,
        )
        assertEquals(
            HttpStatusCode.Forbidden,
            authedClient(strangerEmail, "pw").get("/api/v1/feedbacks/${created.id}/events").status,
        )
    }

    @Test
    fun `the events endpoint returns 404 for a missing feedback`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("user")
        TestUsers.seed(email = email, password = "pw", roles = emptySet())

        assertEquals(
            HttpStatusCode.NotFound,
            authedClient(email, "pw").get("/api/v1/feedbacks/999999/events").status,
        )
    }

    @Test
    fun `soft-deleting a feedback preserves its events and records a deletion event`() = testApplication {
        usePostgresTestcontainer()
        val providerEmail = uniqueEmail("provider")
        val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
        val subjectId = TestUsers.seed(email = uniqueEmail("subject"), password = "pw", roles = emptySet())
        val provider = authedClient(providerEmail, "pw")

        val created = provider.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    subjectId = subjectId, providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_SUBJECT,
                    status = FeedbackStatus.DRAFT, content = "draft",
                ),
            )
        }.body<FeedbackResponse>()

        // The creation event exists…
        assertEquals(1, TestFeedbackEvents.service.listForFeedback(created.id).size)

        // …and the feedback is soft-deleted: the row (and its audit trail) survive, and a deletion
        // event is appended against the acting provider.
        assertEquals(HttpStatusCode.NoContent, provider.delete("/api/v1/feedbacks/${created.id}").status)
        val events = TestFeedbackEvents.service.listForFeedback(created.id)
        assertEquals(2, events.size)
        val deletion = events.first()
        assertEquals(FeedbackEventType.DELETED, deletion.type)
        assertEquals(providerId, deletion.userId)
    }
}
