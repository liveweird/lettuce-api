package ch.nokillswit

import ch.nokillswit.feedbacks.Feedback
import ch.nokillswit.feedbacks.FeedbackCreateRequest
import ch.nokillswit.feedbacks.FeedbackEvent
import ch.nokillswit.feedbacks.FeedbackEventListResponse
import ch.nokillswit.feedbacks.FeedbackEventType
import ch.nokillswit.feedbacks.FeedbackPageResponse
import ch.nokillswit.feedbacks.FeedbackResponse
import ch.nokillswit.feedbacks.FeedbackStatus
import ch.nokillswit.feedbacks.FeedbackVisibility
import ch.nokillswit.notifications.NotificationPageResponse
import ch.nokillswit.notifications.NotificationType
import ch.nokillswit.users.Feature
import ch.nokillswit.users.UserFeaturesUpdateRequest
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

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

    @Test
    fun `two concurrent sweeps over the same overdue rows never double-fire (the updateReturning race fix)`() =
        testApplication {
            usePostgresTestcontainer()
            val providerEmail = uniqueEmail("provider")
            val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
            val requesterIds = (1..3).map {
                TestUsers.seed(email = uniqueEmail("requester$it"), password = "pw", roles = emptySet())
            }
            val ids = requesterIds.map { requesterId ->
                seedOverdueRequest(providerId, requesterId, requesterId, expiresOn = "2020-01-01")
            }

            // Two genuinely concurrent sweeps over the SAME overdue rows: FeedbackService.expireOverdueRequests
            // now derives each call's outcomes ONLY from the rows ITS OWN updateReturning actually
            // flipped, so the combined total across both calls is exactly N — not 2N. Pre-fix, the
            // second call's outcomes came from a stale pre-UPDATE SELECT snapshot and double-fired
            // for rows the first call had already claimed (the bug A1 fixes).
            val (r1, r2) = coroutineScope {
                val a = async { TestServices.feedbacks.expireOverdueRequests() }
                val b = async { TestServices.feedbacks.expireOverdueRequests() }
                a.await() to b.await()
            }
            val outcomes = r1 + r2
            assertEquals(3, outcomes.size)
            assertEquals(ids.toSet(), outcomes.map { it.feedbackId }.toSet())

            // Persist exactly like the route does, then check the totals landed exactly once each.
            outcomes.forEach { outcome ->
                outcome.notifications.forEach { TestNotifications.service.create(it) }
                TestFeedbackEvents.service.create(
                    FeedbackEvent(feedbackId = outcome.feedbackId, userId = outcome.providerId, type = FeedbackEventType.REQUEST_EXPIRED),
                )
            }

            ids.forEach { id ->
                val events = TestFeedbackEvents.service.listForFeedback(id)
                assertEquals(1, events.count { it.type == FeedbackEventType.REQUEST_EXPIRED })
            }

            val provider = authedClient(providerEmail, "pw")
            val providerNotes = provider.get("/api/v1/notifications").body<NotificationPageResponse>().items
            assertEquals(
                3,
                providerNotes.count { it.type == NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER },
            )
        }

    @Test
    fun `a soft-deleted row and non-REQUESTED rows with a stale expiresOn are left untouched by the sweep`() =
        testApplication {
            usePostgresTestcontainer()
            val providerId = TestUsers.seed(email = uniqueEmail("provider"), password = "pw", roles = emptySet())
            val deletedRequesterId =
                TestUsers.seed(email = uniqueEmail("deleted-requester"), password = "pw", roles = emptySet())
            val draftRequesterId =
                TestUsers.seed(email = uniqueEmail("draft-requester"), password = "pw", roles = emptySet())
            val sentRequesterId =
                TestUsers.seed(email = uniqueEmail("sent-requester"), password = "pw", roles = emptySet())

            // A REQUESTED row, overdue, then soft-deleted before the sweep runs.
            val deletedId =
                seedOverdueRequest(providerId, deletedRequesterId, deletedRequesterId, expiresOn = "2020-01-01")
            assertEquals(1, TestServices.feedbacks.delete(deletedId))

            // DRAFT/SENT rows carrying a stale expiresOn — unreachable via the route's create-time
            // validateFeedbackExpiry (REQUESTED-only), but the sweep's WHERE clause (status =
            // REQUESTED) must ignore them regardless of how they came to exist.
            val draftId = TestServices.feedbacks.create(
                Feedback(
                    requesterId = draftRequesterId,
                    subjectId = draftRequesterId,
                    providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
                    status = FeedbackStatus.DRAFT,
                    expiresOn = "2020-01-01",
                ),
            ).id
            val sentId = TestServices.feedbacks.create(
                Feedback(
                    requesterId = sentRequesterId,
                    subjectId = sentRequesterId,
                    providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
                    status = FeedbackStatus.SENT,
                    expiresOn = "2020-01-01",
                ),
            ).id

            val outcomes = TestServices.feedbacks.expireOverdueRequests()
            assertEquals(emptyList(), outcomes.filter { it.feedbackId in setOf(deletedId, draftId, sentId) })
        }

    @Test
    fun `the very list response that triggers the sweep already shows the flipped row as REJECTED`() =
        testApplication {
            usePostgresTestcontainer()
            val requesterEmail = uniqueEmail("requester")
            val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
            val providerEmail = uniqueEmail("provider")
            val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
            val id = seedOverdueRequest(providerId, requesterId, requesterId, expiresOn = "2020-01-01")

            val provider = authedClient(providerEmail, "pw")
            val page = provider.get("/api/v1/feedbacks") { parameter("view", "provided") }.body<FeedbackPageResponse>()
            val row = page.items.single { it.id == id }
            assertEquals(FeedbackStatus.REJECTED, row.status)
        }

    @Test
    fun `a FEEDBACKS-disabled caller's list is 403 and never sweeps an overdue row`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("admin")
        TestUsers.seed(email = adminEmail, password = "pw")
        val admin = authedClient(adminEmail, "pw")
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerEmail = uniqueEmail("provider")
        val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
        val id = seedOverdueRequest(providerId, requesterId, requesterId, expiresOn = "2020-01-01")

        // The features PUT is ADMIN-only (requireAdmin — no self-service exception for a
        // non-admin). MFA must ride along in the wholesale-replace set, else the PUT would
        // re-enable it (v2.4.0's inverted-default gotcha) and the fresh login below would answer
        // an MFA challenge instead of a LoginResponse.
        assertEquals(
            HttpStatusCode.NoContent,
            admin.put("/api/v1/users/$requesterId/features") {
                contentType(ContentType.Application.Json)
                setBody(UserFeaturesUpdateRequest(listOf(Feature.FEEDBACKS, Feature.MFA)))
            }.status,
        )
        // A fresh login mints a token carrying the new disabledFeatures claim.
        val gatedRequester = authedClient(requesterEmail, "pw")
        assertEquals(HttpStatusCode.Forbidden, gatedRequester.get("/api/v1/feedbacks").status)

        // No sweep ran — an unaffected (non-gated) provider still sees it REQUESTED.
        val provider = authedClient(providerEmail, "pw")
        assertEquals(
            FeedbackStatus.REQUESTED,
            provider.get("/api/v1/feedbacks/$id").body<FeedbackResponse>().status,
        )
    }

    @Test
    fun `the sweep bumps lastModified on the flip`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerId = TestUsers.seed(email = uniqueEmail("provider"), password = "pw", roles = emptySet())
        val id = seedOverdueRequest(providerId, requesterId, requesterId, expiresOn = "2020-01-01")

        val requester = authedClient(requesterEmail, "pw")
        val before = requester.get("/api/v1/feedbacks/$id").body<FeedbackResponse>().lastModified

        requester.get("/api/v1/feedbacks") // the sweep

        val after = requester.get("/api/v1/feedbacks/$id").body<FeedbackResponse>().lastModified
        assertTrue(after > before)
    }

    @Test
    fun `the expiry notifications carry exactly requester-provider-subject params and no link`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerEmail = uniqueEmail("provider")
        val providerId = TestUsers.seed(email = providerEmail, password = "pw", roles = emptySet())
        seedOverdueRequest(providerId, requesterId, requesterId, expiresOn = "2020-01-01")

        val requester = authedClient(requesterEmail, "pw")
        val provider = authedClient(providerEmail, "pw")
        requester.get("/api/v1/feedbacks") // the sweep

        val toRequester = requester.get("/api/v1/notifications").body<NotificationPageResponse>().items
            .single { it.type == NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER }
        assertEquals(setOf("requester", "provider", "subject"), toRequester.params.keys)
        assertNull(toRequester.link)

        val toProvider = provider.get("/api/v1/notifications").body<NotificationPageResponse>().items
            .single { it.type == NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER }
        assertEquals(setOf("requester", "provider", "subject"), toProvider.params.keys)
        assertNull(toProvider.link)
    }

    @Test
    fun `expiresOn rides the list rows`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("requester")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw", roles = emptySet())
        val providerId = TestUsers.seed(email = uniqueEmail("provider"), password = "pw", roles = emptySet())
        val requester = authedClient(requesterEmail, "pw")

        val deadline = LocalDate.now().plusDays(3).toString()
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
        }.body<FeedbackResponse>()

        val page = requester.get("/api/v1/feedbacks") { parameter("view", "received") }.body<FeedbackPageResponse>()
        val row = page.items.single { it.id == created.id }
        assertEquals(deadline, row.expiresOn)
    }
}
