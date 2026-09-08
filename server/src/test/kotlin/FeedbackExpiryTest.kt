package ch.nokillswit

import ch.nokillswit.feedbacks.Feedback
import ch.nokillswit.feedbacks.FeedbackCreateRequest
import ch.nokillswit.feedbacks.FeedbackEventListResponse
import ch.nokillswit.feedbacks.FeedbackEventType
import ch.nokillswit.feedbacks.FeedbackResponse
import ch.nokillswit.feedbacks.FeedbackStatus
import ch.nokillswit.feedbacks.FeedbackVisibility
import ch.nokillswit.notifications.NotificationPageResponse
import ch.nokillswit.notifications.NotificationType
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The feedback request expiration + auto-reject-on-expiry feature (v3.8.0, plan
 * "proud-baking-melody"): an optional `expiresOn` deadline on a `REQUESTED` feedback, flipped to
 * `REJECTED` by the lazy sweep at the top of `GET /api/v1/feedbacks`
 * (`FeedbackService.expireOverdueRequests`) — no background job. See
 * "Feedback request expiration" in `.claude/docs/features/feedbacks.md`.
 */
class FeedbackExpiryTest {

    /**
     * A REQUESTED feedback with the given `expiresOn`, created directly through the service (not
     * the route) — the route's create-time `validateFeedbackExpiry` rejects a past date, but the
     * sweep must be exercisable against an already-overdue row (the Postgres-direct precedent
     * from the plan's manual verification step, done here deterministically).
     */
    private suspend fun seedOverdueRequest(
        providerId: UInt,
        subjectId: UInt,
        requesterId: UInt,
        expiresOn: String?,
    ): UInt =
        TestServices.feedbacks.create(
            Feedback(
                requesterId = requesterId,
                subjectId = subjectId,
                providerId = providerId,
                visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
                status = FeedbackStatus.REQUESTED,
                expiresOn = expiresOn,
            ),
        ).id

    @Test
    fun `creating a REQUESTED feedback with expiresOn persists and returns it`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerId = TestUsers.seed(email = uniqueEmail("provider"), password = "pw", roles = emptySet())
        val requester = authedClient(requesterEmail, "pw")

        val deadline = LocalDate.now().plusDays(7).toString()
        val created = requester.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    requesterId = requesterId,
                    subjectId = requesterId,
                    providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
                    status = FeedbackStatus.REQUESTED,
                    expiresOn = deadline,
                ),
            )
        }
        assertEquals(HttpStatusCode.Created, created.status)
        val body = created.body<FeedbackResponse>()
        assertEquals(deadline, body.expiresOn)

        // Round-trips on the single GET too.
        val fetched = requester.get("/api/v1/feedbacks/${body.id}").body<FeedbackResponse>()
        assertEquals(deadline, fetched.expiresOn)
    }

    @Test
    fun `the sweep flips an overdue REQUESTED row to REJECTED, records the expiry event, and notifies both parties`() =
        testApplication {
            usePostgresTestcontainer()
            val requesterEmail = uniqueEmail("requester")
            val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
            val providerEmail = uniqueEmail("provider")
            val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
            val id = seedOverdueRequest(providerId, requesterId, requesterId, expiresOn = "2020-01-01")

            val provider = authedClient(providerEmail, "pw")
            val requester = authedClient(requesterEmail, "pw")

            // The sweep runs at the top of the list handler — any authenticated GET triggers it,
            // regardless of caller/view (it is not scoped to the caller).
            assertEquals(HttpStatusCode.OK, provider.get("/api/v1/feedbacks").status)

            assertEquals(
                FeedbackStatus.REJECTED,
                provider.get("/api/v1/feedbacks/$id").body<FeedbackResponse>().status,
            )

            val events = provider.get("/api/v1/feedbacks/$id/events").body<FeedbackEventListResponse>()
            val expiry = events.items.single { it.type == FeedbackEventType.REQUEST_EXPIRED }
            assertEquals(emptyMap(), expiry.params)
            // feedback_events.user_id is NOT NULL — the expiry event is attributed to the
            // provider (the sentence itself carries no actor).
            assertEquals(providerId, expiry.userId)

            val requesterNotes = requester.get("/api/v1/notifications").body<NotificationPageResponse>().items
            val toRequester = requesterNotes.single { it.type == NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER }
            assertEquals(requesterId, toRequester.recipientId)

            val providerNotes = provider.get("/api/v1/notifications").body<NotificationPageResponse>().items
            val toProvider = providerNotes.single { it.type == NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER }
            assertEquals(providerId, toProvider.recipientId)
        }

    @Test
    fun `the sweep is idempotent — a second call does not double-fire`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerEmail = uniqueEmail("provider")
        val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
        val id = seedOverdueRequest(providerId, requesterId, requesterId, expiresOn = "2020-01-01")

        val provider = authedClient(providerEmail, "pw")
        val requester = authedClient(requesterEmail, "pw")

        // First sweep flips it…
        provider.get("/api/v1/feedbacks")
        // …a second sweep must no-op: the row is REJECTED now, so it no longer matches the
        // REQUESTED predicate.
        provider.get("/api/v1/feedbacks")

        val events = provider.get("/api/v1/feedbacks/$id/events").body<FeedbackEventListResponse>()
        assertEquals(1, events.items.count { it.type == FeedbackEventType.REQUEST_EXPIRED })

        val requesterNotes = requester.get("/api/v1/notifications").body<NotificationPageResponse>().items
        assertEquals(1, requesterNotes.count { it.type == NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER })
        val providerNotes = provider.get("/api/v1/notifications").body<NotificationPageResponse>().items
        assertEquals(1, providerNotes.count { it.type == NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER })
    }

    @Test
    fun `a not-yet-due REQUESTED feedback stays REQUESTED after a sweep`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerId = TestUsers.seed(email = uniqueEmail("provider"), password = "pw", roles = emptySet())
        val requester: HttpClient = authedClient(requesterEmail, "pw")

        val tomorrow = LocalDate.now().plusDays(1).toString()
        val created = requester.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    requesterId = requesterId,
                    subjectId = requesterId,
                    providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
                    status = FeedbackStatus.REQUESTED,
                    expiresOn = tomorrow,
                ),
            )
        }.body<FeedbackResponse>()

        requester.get("/api/v1/feedbacks") // the sweep
        val fetched = requester.get("/api/v1/feedbacks/${created.id}").body<FeedbackResponse>()
        assertEquals(FeedbackStatus.REQUESTED, fetched.status)
        assertEquals(tomorrow, fetched.expiresOn)
    }

    @Test
    fun `a REQUESTED feedback with no expiresOn never expires`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerId = TestUsers.seed(email = uniqueEmail("provider"), password = "pw", roles = emptySet())
        val requester: HttpClient = authedClient(requesterEmail, "pw")

        val created = requester.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    requesterId = requesterId,
                    subjectId = requesterId,
                    providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
                    status = FeedbackStatus.REQUESTED,
                ),
            )
        }.body<FeedbackResponse>()
        assertNull(created.expiresOn)

        requester.get("/api/v1/feedbacks") // the sweep
        val fetched = requester.get("/api/v1/feedbacks/${created.id}").body<FeedbackResponse>()
        assertEquals(FeedbackStatus.REQUESTED, fetched.status)
        assertNull(fetched.expiresOn)
    }

    @Test
    fun `a request expiring exactly today is still open (within the period)`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerId = TestUsers.seed(email = uniqueEmail("provider"), password = "pw", roles = emptySet())
        // expires_on < today is overdue — exactly today must still be open ("within the period",
        // the plan's rule).
        val today = LocalDate.now().toString()
        val id = seedOverdueRequest(providerId, requesterId, requesterId, expiresOn = today)

        val requester = authedClient(requesterEmail, "pw")
        assertEquals(HttpStatusCode.OK, requester.get("/api/v1/feedbacks").status)
        assertEquals(
            FeedbackStatus.REQUESTED,
            requester.get("/api/v1/feedbacks/$id").body<FeedbackResponse>().status,
        )
    }
}
