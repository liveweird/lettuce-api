package ch.nokillswit

import ch.nokillswit.auth.LoginRequest
import ch.nokillswit.auth.LoginResponse
import ch.nokillswit.feedbacks.FeedbackContentUpdate
import ch.nokillswit.feedbacks.FeedbackCreateRequest
import ch.nokillswit.feedbacks.FeedbackResponse
import ch.nokillswit.feedbacks.FeedbackStatus
import ch.nokillswit.feedbacks.FeedbackVisibility
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.teams.Team
import ch.nokillswit.templates.Template
import ch.nokillswit.users.UserRequest
import ch.nokillswit.users.UserResponse
import ch.nokillswit.users.UserRole
import ch.nokillswit.users.UserUpdateRequest
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Up-front payload validation (400 + ProblemDetail) instead of DB-level failures (500):
 * blank/oversized names and emails, and the password minimum on user creation.
 */
class PayloadValidationTest {


    private suspend fun ApplicationTestBuilder.adminClient(): HttpClient {
        val email = uniqueEmail("admin")
        TestUsers.seed(email = email, password = "pw-123456789", roles = setOf(UserRole.ADMIN))
        val base = jsonClient()
        val token = base.post("/api/v1/login") {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(email, "pw-123456789"))
        }.body<LoginResponse>().token
        return createClient {
            lettuceTestClientDefaults()
            install(DefaultRequest) { header(HttpHeaders.Authorization, "Bearer $token") }
        }
    }

    @Test
    fun `user create rejects blank and oversized fields and short passwords with 400`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()

        suspend fun createStatus(name: String, email: String, password: String): HttpStatusCode =
            client.post("/api/v1/users") {
                contentType(ContentType.Application.Json)
                setBody(UserRequest(name = name, email = email, password = password))
            }.status

        assertEquals(HttpStatusCode.BadRequest, createStatus("  ", uniqueEmail("u"), "pw-123456789"))
        assertEquals(HttpStatusCode.BadRequest, createStatus("x".repeat(51), uniqueEmail("u"), "pw-123456789"))
        assertEquals(HttpStatusCode.BadRequest, createStatus("Ok", " ", "pw-123456789"))
        assertEquals(HttpStatusCode.BadRequest, createStatus("Ok", "a".repeat(255) + "@x", "pw-123456789"))
        assertEquals(HttpStatusCode.BadRequest, createStatus("Ok", "no-at-sign.example", "pw-123456789"))
        assertEquals(HttpStatusCode.BadRequest, createStatus("Ok", uniqueEmail("u"), "short"))
        // Over bcrypt's 71-UTF-8-byte ceiling: a 400, not a 500 from the hasher — by char count…
        assertEquals(HttpStatusCode.BadRequest, createStatus("Ok", uniqueEmail("u"), "x".repeat(72)))
        // …and by byte count (36 × 2-byte 'ó' = 72 bytes from only 36 chars).
        assertEquals(HttpStatusCode.BadRequest, createStatus("Ok", uniqueEmail("u"), "ó".repeat(36)))
        // Control: a valid payload passes.
        assertEquals(HttpStatusCode.Created, createStatus("Ok", uniqueEmail("u"), "pw-123456789"))
    }

    @Test
    fun `user create rejects a blank or oversized unique id with 400`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()

        suspend fun createStatus(uniqueId: String?): HttpStatusCode =
            client.post("/api/v1/users") {
                contentType(ContentType.Application.Json)
                setBody(
                    UserRequest(
                        name = "Ok", email = uniqueEmail("uid"),
                        password = "pw-123456789", uniqueId = uniqueId,
                    ),
                )
            }.status

        assertEquals(HttpStatusCode.BadRequest, createStatus("  "))
        assertEquals(HttpStatusCode.BadRequest, createStatus("x".repeat(51)))
        // Control: exactly at the cap (unique per run — the id is a unique column) and absent both pass.
        val atCap = (uniqueEmail("cap").substringBefore("@") + "-" + "x".repeat(50)).take(50)
        assertEquals(HttpStatusCode.Created, createStatus(atCap))
        assertEquals(HttpStatusCode.Created, createStatus(null))
    }

    @Test
    fun `a NUL character in stored text is a 400 problem - not a 500`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()
        // PostgreSQL rejects 0x00 inside text values (SQLSTATE 22021); the central mapping in
        // ErrorHandling.kt turns that into a 400 for every plaintext column at once.
        val response = client.post("/api/v1/users") {
            contentType(ContentType.Application.Json)
            setBody(UserRequest(name = "bad\u0000name", email = uniqueEmail("nul"), password = "pw-123456789"))
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `a body-less POST is a 400 problem - not a 500`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()
        // No body and no Content-Type: ContentNegotiation never runs (no converter matches
        // ContentType.Any), so `receive` throws CannotTransformContentToTypeException — which
        // used to escape to the 500 catch-all; the v2.34.0 central mapping (the 22021
        // precedent) turns it into a 400 for every body-receiving route at once. (CSRF is off
        // in tests, so the request reaches the handler.)
        val response = client.post("/api/v1/templates")
        assertEquals(HttpStatusCode.BadRequest, response.status)
        val problem = response.body<ProblemDetail>()
        assertEquals(HttpStatusCode.BadRequest.value, problem.status)
        assertEquals("Request body is missing or not JSON", problem.detail)
    }

    @Test
    fun `a non-numeric or out-of-range path id is a 400 problem`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()
        // Ktor's resource transform rejects both before the handler; the spec declares the 400
        // (the OpenApiConformance plugin checks that declaration on these very requests).
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/users/not-a-number").status)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/users/4161833451198").status)
        // A negative id used to WRAP (kotlinx decodes UInt via toInt().toUInt(), so -1 became
        // 4294967295 and flowed into the normal 403/404 lookup) — the central pre-routing
        // intercept makes it the 400 the spec's `minimum: 0` always promised (v2.35.0, MT-005).
        val negative = client.get("/api/v1/users/-1")
        assertEquals(HttpStatusCode.BadRequest, negative.status)
        assertEquals("Path id must be a non-negative integer", negative.body<ProblemDetail>().detail)
    }

    @Test
    fun `single-line identity fields reject control characters and trim to canonical`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()

        suspend fun createStatus(name: String, email: String): HttpStatusCode =
            client.post("/api/v1/users") {
                contentType(ContentType.Application.Json)
                setBody(UserRequest(name = name, email = email, password = "pw-123456789"))
            }.status

        // Control characters (MT-002): newlines/tabs in a name or email are a 400, not stored.
        assertEquals(HttpStatusCode.BadRequest, createStatus("Line\nBreak", uniqueEmail("u")))
        assertEquals(HttpStatusCode.BadRequest, createStatus("Tab\tName", uniqueEmail("u")))
        assertEquals(HttpStatusCode.BadRequest, createStatus("Ok", "evil\n${uniqueEmail("u")}"))
        val managerId = TestUsers.seed(email = uniqueEmail("mgr"), password = "pw-123456789")
        val teamControl = client.post("/api/v1/teams") {
            contentType(ContentType.Application.Json)
            setBody(Team(name = "AA\u0007BB", managerId = managerId, memberIds = emptyList()))
        }
        assertEquals(HttpStatusCode.BadRequest, teamControl.status)
        val templateControl = client.post("/api/v1/templates") {
            contentType(ContentType.Application.Json)
            setBody(Template(name = "Bad\u000BName", content = "fine"))
        }
        assertEquals(HttpStatusCode.BadRequest, templateControl.status)

        // Surrounding whitespace is trimmed before validation and persistence.
        val padded = client.post("/api/v1/users") {
            contentType(ContentType.Application.Json)
            setBody(UserRequest(name = "  Padded Name  ", email = "  ${uniqueEmail("pad")}  ", password = "pw-123456789"))
        }
        assertEquals(HttpStatusCode.Created, padded.status)
        val created = padded.body<UserResponse>()
        assertEquals("Padded Name", created.name)
        assertEquals(created.email.trim(), created.email)
    }

    @Test
    fun `a repeated scalar query parameter is a 400 problem`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()
        // Repetition is reserved for per-endpoint documented IN semantics (API-LIST-004) —
        // silently first-winning would hide the caller's conflicting input (MT-003).
        val paging = client.get("/api/v1/users?page=1&page=2")
        assertEquals(HttpStatusCode.BadRequest, paging.status)
        assertEquals("Parameter 'page' must not be repeated", paging.body<ProblemDetail>().detail)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/users?role=ADMIN&role=HR").status)
        assertEquals(HttpStatusCode.BadRequest, client.get("/api/v1/users?sort=id&sort=name").status)
    }

    @Test
    fun `malformed request bodies answer with fixed vocabulary - never internal class names`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()
        // ContentNegotiation's wrap used to surface "Failed to convert request body to class
        // ch.nokillswit.teams.Team" — internal package structure in a client-facing body
        // (MT-007). The cause-chain discriminator replaces exactly that class of message …
        val missingFields = client.post("/api/v1/templates") {
            contentType(ContentType.Application.Json)
            setBody("{}")
        }
        assertEquals(HttpStatusCode.BadRequest, missingFields.status)
        assertEquals(
            "Request body is invalid or does not match the expected schema",
            missingFields.body<ProblemDetail>().detail,
        )
        val notJson = client.post("/api/v1/templates") {
            contentType(ContentType.Application.Json)
            setBody("not json at all")
        }
        assertEquals(
            "Request body is invalid or does not match the expected schema",
            notJson.body<ProblemDetail>().detail,
        )
        // … while our validators' intentional messages pass through untouched.
        val blankName = client.post("/api/v1/templates") {
            contentType(ContentType.Application.Json)
            setBody(Template(name = " ", content = "fine"))
        }
        assertEquals("Template name must not be blank", blankName.body<ProblemDetail>().detail)
    }

    @Test
    fun `user update applies the same name and email checks`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()
        val id = TestUsers.seed(email = uniqueEmail("target"), password = "pw-123456789")

        val response = client.put("/api/v1/users/$id") {
            contentType(ContentType.Application.Json)
            setBody(UserUpdateRequest(name = "x".repeat(51), email = uniqueEmail("t"), roles = emptyList()))
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `team create and update reject blank or oversized names with 400`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()
        val managerId = TestUsers.seed(email = uniqueEmail("mgr"), password = "pw-123456789")

        val blank = client.post("/api/v1/teams") {
            contentType(ContentType.Application.Json)
            setBody(Team(name = "  ", managerId = managerId, memberIds = emptyList()))
        }
        assertEquals(HttpStatusCode.BadRequest, blank.status)

        val oversized = client.post("/api/v1/teams") {
            contentType(ContentType.Application.Json)
            setBody(Team(name = "x".repeat(101), managerId = managerId, memberIds = emptyList()))
        }
        assertEquals(HttpStatusCode.BadRequest, oversized.status)
    }

    @Test
    fun `team create and update reject rosters above the member cap with 400`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()
        val managerId = TestUsers.seed(email = uniqueEmail("capmgr"), password = "pw-123456789")
        // 201 distinct ids — over the MAX_TEAM_MEMBERS = 200 cap; the shape check fires before
        // any per-id existence/deactivation lookups, so fabricated ids never reach the DB.
        val oversizedRoster = (1_000_000u until 1_000_201u).toList()

        val create = client.post("/api/v1/teams") {
            contentType(ContentType.Application.Json)
            setBody(Team(name = "cap-${java.util.UUID.randomUUID()}", managerId = managerId, memberIds = oversizedRoster))
        }
        assertEquals(HttpStatusCode.BadRequest, create.status)
        assertEquals("A team may have at most 200 members", create.body<ProblemDetail>().detail)

        val teamId = TestServices.teams.create(
            Team(name = "cap-${java.util.UUID.randomUUID()}", managerId = managerId),
        )
        val update = client.put("/api/v1/teams/$teamId") {
            contentType(ContentType.Application.Json)
            setBody(Team(name = "still-fine", managerId = managerId, memberIds = oversizedRoster))
        }
        assertEquals(HttpStatusCode.BadRequest, update.status)
        assertEquals("A team may have at most 200 members", update.body<ProblemDetail>().detail)
    }

    @Test
    fun `template create rejects blank or oversized names with 400`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()

        val blank = client.post("/api/v1/templates") {
            contentType(ContentType.Application.Json)
            setBody(Template(name = " ", content = "body"))
        }
        assertEquals(HttpStatusCode.BadRequest, blank.status)

        val oversized = client.post("/api/v1/templates") {
            contentType(ContentType.Application.Json)
            setBody(Template(name = "x".repeat(101), content = "body"))
        }
        assertEquals(HttpStatusCode.BadRequest, oversized.status)
    }

    @Test
    fun `template content is capped at 5000 - 400 over, 201 at the boundary`() = testApplication {
        usePostgresTestcontainer()
        val client = adminClient()

        val over = client.post("/api/v1/templates") {
            contentType(ContentType.Application.Json)
            setBody(Template(name = uniqueEmail("tpl-over"), content = "x".repeat(5001)))
        }
        assertEquals(HttpStatusCode.BadRequest, over.status)

        val atLimit = client.post("/api/v1/templates") {
            contentType(ContentType.Application.Json)
            setBody(Template(name = uniqueEmail("tpl-max"), content = "x".repeat(5000)))
        }
        assertEquals(HttpStatusCode.Created, atLimit.status)
    }

    @Test
    fun `feedback content and requester message are length-capped with 400`() = testApplication {
        usePostgresTestcontainer()
        val email = uniqueEmail("fb-len")
        val callerId = TestUsers.seed(email = email, password = "pw-123456789", roles = emptySet())
        val otherId = TestUsers.seed(email = uniqueEmail("fb-len-p"), password = "pw", roles = emptySet())
        val client = authedClient(email, "pw-123456789")

        // Caller-authored draft about the other user (provider == subject is rejected since
        // v2.36.0, so the fixture needs a real subject).
        suspend fun create(content: String) = client.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    subjectId = otherId,
                    providerId = callerId,
                    visibility = FeedbackVisibility.PROVIDER_SUBJECT,
                    status = FeedbackStatus.DRAFT,
                    content = content,
                ),
            )
        }

        assertEquals(HttpStatusCode.BadRequest, create("x".repeat(5001)).status)
        val atLimit = create("x".repeat(5000))
        assertEquals(HttpStatusCode.Created, atLimit.status)

        // The PUT edit path applies the same content cap (reuse the draft — a second
        // in-progress create for the same parties would hit the no-duplicate 409).
        val id = atLimit.body<FeedbackResponse>().id
        val putOver = client.put("/api/v1/feedbacks/$id") {
            contentType(ContentType.Application.Json)
            setBody(FeedbackContentUpdate(content = "x".repeat(5001), visibility = FeedbackVisibility.PROVIDER_SUBJECT))
        }
        assertEquals(HttpStatusCode.BadRequest, putOver.status)

        // Requester message (create-only field) has its own 1000 cap.
        val requestOver = client.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    requesterId = callerId,
                    subjectId = callerId,
                    providerId = otherId,
                    visibility = FeedbackVisibility.PROVIDER_REQUESTER,
                    status = FeedbackStatus.REQUESTED,
                    requesterMessage = "x".repeat(1001),
                ),
            )
        }
        assertEquals(HttpStatusCode.BadRequest, requestOver.status)
    }

    @Test
    fun `feedback expiresOn is validated — REQUESTED-only, strict ISO, not in the past`() = testApplication {
        usePostgresTestcontainer()
        val requesterEmail = uniqueEmail("fb-exp")
        val requesterId = TestUsers.seed(email = requesterEmail, password = "pw-123456789", roles = emptySet())
        val providerId = TestUsers.seed(email = uniqueEmail("fb-exp-p"), password = "pw", roles = emptySet())
        val client = authedClient(requesterEmail, "pw-123456789")

        suspend fun createRequested(expiresOn: String?) = client.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    requesterId = requesterId,
                    subjectId = requesterId,
                    providerId = providerId,
                    visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
                    status = FeedbackStatus.REQUESTED,
                    expiresOn = expiresOn,
                ),
            )
        }

        // Malformed date.
        assertEquals(HttpStatusCode.BadRequest, createRequested("not-a-date").status)
        // In the past.
        assertEquals(HttpStatusCode.BadRequest, createRequested("2020-01-01").status)
        // Valid: not in the past, strict ISO.
        val ok = createRequested("2099-12-31")
        assertEquals(HttpStatusCode.Created, ok.status)
        assertEquals("2099-12-31", ok.body<FeedbackResponse>().expiresOn)

        // Non-REQUESTED status with an expiresOn is rejected (a DRAFT never expires).
        val draftWithExpiry = client.post("/api/v1/feedbacks") {
            contentType(ContentType.Application.Json)
            setBody(
                FeedbackCreateRequest(
                    subjectId = providerId,
                    providerId = requesterId,
                    visibility = FeedbackVisibility.PROVIDER_SUBJECT,
                    status = FeedbackStatus.DRAFT,
                    expiresOn = "2099-12-31",
                ),
            )
        }
        assertEquals(HttpStatusCode.BadRequest, draftWithExpiry.status)

        // One day of UTC timezone slack (the goals/KPI/career precedent): today and
        // today-minus-1 are both accepted, today-minus-2 is rejected. Each accepted create
        // uses its own fresh (subject, provider, requester) triple, so it can't collide with
        // the still-open REQUESTED row the "2099-12-31" case above created (the no-duplicate 409).
        val today = LocalDate.now()
        assertEquals(HttpStatusCode.BadRequest, createRequested(today.minusDays(2).toString()).status)

        suspend fun createRequestedWithFreshParties(label: String, expiresOn: String): HttpStatusCode {
            val reqEmail = uniqueEmail("$label-r")
            val reqId = TestUsers.seed(email = reqEmail, password = "pw-123456789", roles = emptySet())
            val provId = TestUsers.seed(email = uniqueEmail("$label-p"), password = "pw-123456789", roles = emptySet())
            val freshClient = authedClient(reqEmail, "pw-123456789")
            return freshClient.post("/api/v1/feedbacks") {
                contentType(ContentType.Application.Json)
                setBody(
                    FeedbackCreateRequest(
                        requesterId = reqId,
                        subjectId = reqId,
                        providerId = provId,
                        visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
                        status = FeedbackStatus.REQUESTED,
                        expiresOn = expiresOn,
                    ),
                )
            }.status
        }

        assertEquals(HttpStatusCode.Created, createRequestedWithFreshParties("fb-exp-y", today.minusDays(1).toString()))
        assertEquals(HttpStatusCode.Created, createRequestedWithFreshParties("fb-exp-t", today.toString()))
    }

    @Test
    fun `a wrong-method call answers 405 with a problem body`() = testApplication {
        usePostgresTestcontainer()
        // Routing's method-mismatch rejection used to be a bodiless 405 (MT-004; API-ERR-001).
        // Deliberately the DEFAULT client: a wrong-method operation is outside the spec by
        // definition, and the conformance plugin would (correctly) flag it on jsonClient().
        val response = client.patch("/api/v1/users")
        assertEquals(HttpStatusCode.MethodNotAllowed, response.status)
        assertEquals("application", response.contentType()?.contentType)
        assertEquals("problem+json", response.contentType()?.contentSubtype)
        assertTrue(response.bodyAsText().contains("Method not allowed for this resource"))
    }
}
