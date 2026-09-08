package ch.nokillswit.feedbacks

import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.canReadFeedbackContent
import ch.nokillswit.authz.requireFeatureEnabled
import ch.nokillswit.authz.requireAuditListAccess
import ch.nokillswit.authz.requireFeedbackReadAllowingManager
import ch.nokillswit.authz.requireFeedbackWrite
import ch.nokillswit.infra.db.requireValidReferences
import ch.nokillswit.infra.paging.optionalIncludeIndirect
import ch.nokillswit.infra.paging.uintOnlyForView
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.infra.paging.optionalString
import ch.nokillswit.infra.paging.optionalLong
import ch.nokillswit.infra.paging.optionalUInt
import ch.nokillswit.infra.paging.toPage
import ch.nokillswit.notifications.NotificationServiceKey
import ch.nokillswit.users.Feature
import ch.nokillswit.users.UserServiceKey
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.resources.put
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import java.time.LocalDate
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/feedbacks")
class Feedbacks {
    // The no-duplicate early check for the SPA create screens (see the GET handler).
    @Serializable
    @Resource("duplicate-check")
    class DuplicateCheck(val parent: Feedbacks = Feedbacks())

    @Serializable
    @Resource("{id}")
    class Id(val parent: Feedbacks = Feedbacks(), val id: UInt) {
        @Serializable
        @Resource("events")
        class Events(val parent: Id)

        // Lifecycle-transition actions (POST, no body). The state machine gates which are valid
        // from the current status (invalid → 409).
        @Serializable @Resource("send") class Send(val parent: Id)

        @Serializable @Resource("withdraw") class Withdraw(val parent: Id)

        @Serializable @Resource("reject") class Reject(val parent: Id)

        @Serializable @Resource("pick-up") class PickUp(val parent: Id)
    }
}

// Turn a structured event descriptor into the persistable audit event (the SPA localizes it).
private fun FeedbackEventDescriptor.toEvent(feedbackId: UInt, userId: UInt) = FeedbackEvent(
    feedbackId = feedbackId,
    userId = userId,
    type = type,
    params = params,
)

// The gated caller (V46): every feedback handler resolves its principal through this, so the
// per-user FEEDBACKS flag is enforced before any other guard or read.
private fun ApplicationCall.feedbackCaller() =
    caller().also { requireFeatureEnabled(it, Feature.FEEDBACKS) }

fun Application.configureFeedbackRoutes() {
    val feedbackService = attributes[FeedbackServiceKey]
    val feedbackEventService = attributes[FeedbackEventServiceKey]
    val notificationService = attributes[NotificationServiceKey]
    val userService = attributes[UserServiceKey]

    // The uniform read preamble (the 404-before-403 idiom): resolves the feedback (missing →
    // NotFoundException) and enforces the read matrix (parties / audited HR / delivered-only
    // chain managers / PUBLIC+SENT — the guard itself throws ForbiddenException). Whether the
    // CONTENT may be shown stays a separate gate (canReadFeedbackContent) at the
    // single-document GET.
    suspend fun readGuardedFeedback(call: ApplicationCall, feedbackId: UInt): Feedback {
        val caller = call.feedbackCaller()
        val feedback = feedbackService.read(feedbackId)
            ?: throw NotFoundException("Feedback not found")
        requireFeedbackReadAllowingManager(caller, feedback, feedbackId) {
            feedbackService.managesAnySubject(caller.userId, feedback.subjectIds)
        }
        return feedback
    }

    // The write sibling: provider-only (nobody else — ADMIN included). Guards run BEFORE any
    // body is received, so an outsider's malformed payload is still 403.
    suspend fun writeGuardedFeedback(call: ApplicationCall, feedbackId: UInt): Feedback {
        // The gated caller resolves FIRST: a FEEDBACKS-disabled caller gets a uniform 403
        // before the read (the feature 403 must precede the 404).
        val caller = call.feedbackCaller()
        val feedback = feedbackService.read(feedbackId)
            ?: throw NotFoundException("Feedback not found")
        requireFeedbackWrite(caller, feedback)
        return feedback
    }

    // Shared handler for the lifecycle-transition action endpoints: provider-only, 404 when
    // missing, 409 (via ConflictException in the service) when the transition isn't allowed,
    // otherwise it applies the change, delivers notifications, and records the audit event.
    suspend fun transitionTo(call: ApplicationCall, feedbackId: UInt, target: FeedbackStatus) {
        val existing = writeGuardedFeedback(call, feedbackId)
        val toNotify = feedbackService.transition(feedbackId, target)
            ?: throw NotFoundException("Feedback not found")
        toNotify.forEach { notificationService.create(it) }
        feedbackUpdateEvent(existing, existing.copy(status = target))?.let { descriptor ->
            feedbackEventService.create(descriptor.toEvent(feedbackId, call.caller().userId))
        }
        call.respond(HttpStatusCode.NoContent)
    }

    routing {
        authenticate {
            get<Feedbacks> {
                val caller = call.feedbackCaller()
                // The lazy expiry sweep (v3.8.0 — no background job): flip overdue REQUESTED rows
                // to REJECTED and persist their event + notifications exactly like the manual
                // `POST …/reject` path, so the list built below already reflects them. This is a
                // deliberate exception, not an established pattern: it is the first WRITE this
                // codebase performs on a read-only GET path (AlertService.visible is a read-side
                // filter with no write of its own, and TokenBlocklistService's prune runs on the
                // logout WRITE path, not a GET — neither is a precedent for this). Chosen because
                // a background job was out of scope and the list route is hit constantly, keeping
                // expiry prompt in practice.
                feedbackService.expireOverdueRequests(LocalDate.now()).forEach { outcome ->
                    outcome.notifications.forEach { notificationService.create(it) }
                    feedbackEventService.create(
                        feedbackExpiryEvent().toEvent(outcome.feedbackId, outcome.providerId),
                    )
                }
                val params = call.request.queryParameters
                val view = when (val raw = params.optionalString("view") ?: "received") {
                    "received" -> FeedbackListView.RECEIVED
                    "provided" -> FeedbackListView.PROVIDED
                    "team" -> FeedbackListView.TEAM
                    "user" -> FeedbackListView.USER
                    "kudos" -> FeedbackListView.KUDOS
                    else -> throw BadRequestException("Unknown view: $raw (allowed: received, provided, team, user, kudos)")
                }
                val paging = call.parsePaging(
                    sortable = setOf("id", "requesterName", "subjectName", "providerName", "visibility", "status", "lastModified"),
                )
                val visibilityFilter = params.optionalEnum<FeedbackVisibility>("visibility")
                val statusFilter = params.optionalEnum<FeedbackStatus>("status")
                val providerIdFilter = params.optionalUInt("providerId")
                val subjectIdFilter = params.optionalUInt("subjectId")
                val lastModifiedGteFilter = params.optionalLong("lastModified[gte]")
                val includeIndirect = params.optionalIncludeIndirect(view, listOf(FeedbackListView.TEAM))
                // The auditor view (HR-only): view-shape validation like counterpartId on the
                // 1:1 list, then the role gate (every use is audit-logged).
                val userId = params.uintOnlyForView("userId", view, FeedbackListView.USER)
                if (view == FeedbackListView.USER) {
                    requireAuditListAccess(caller, "feedback", userId!!)
                }
                val filter = FeedbackListFilter(
                    requesterName = params.optionalString("requesterName"),
                    subjectName = params.optionalString("subjectName"),
                    providerName = params.optionalString("providerName"),
                    providerId = providerIdFilter,
                    subjectId = subjectIdFilter,
                    visibility = visibilityFilter,
                    status = statusFilter,
                    lastModifiedGte = lastModifiedGteFilter,
                )
                val result = feedbackService.list(
                    view,
                    caller.userId,
                    filter,
                    paging,
                    includeIndirect = includeIndirect,
                    targetUserId = userId,
                )
                call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
            }
            get<Feedbacks.DuplicateCheck> {
                val caller = call.feedbackCaller()
                val params = call.request.queryParameters
                val subjectId = params.optionalUInt("subjectId")
                    ?: throw BadRequestException("subjectId is required")
                val providerId = params.optionalUInt("providerId")
                    ?: throw BadRequestException("providerId is required")
                val requesterId = params.optionalUInt("requesterId")
                // Same party rule as creation: only someone who could create this feedback may
                // probe for its in-progress duplicate — and a matching DRAFT/REQUESTED row always
                // has the caller as a party, so no private draft's existence can leak.
                if (caller.userId != providerId && caller.userId != requesterId) {
                    throw ForbiddenException("You may only check feedback you would provide or request")
                }
                val duplicate = feedbackService.findOpenDuplicate(subjectId, providerId, requesterId)
                call.respond(
                    HttpStatusCode.OK,
                    DuplicateCheckResponse(existingId = duplicate?.first, existingStatus = duplicate?.second),
                )
            }
            post<Feedbacks> {
                val caller = call.feedbackCaller()
                val feedback = call.receive<FeedbackCreateRequest>().toFeedback()
                // A caller may only create feedback they are a party to — the provider (they author
                // it) or the requester (they ask for it). Nobody creates on behalf of others
                // (ADMIN included): this prevents authoring feedback as someone else or forging a
                // request from someone else.
                if (caller.userId != feedback.providerId && caller.userId != feedback.requesterId) {
                    throw ForbiddenException("You may only create feedback you provide or request")
                }
                // Feedback about yourself (the retired self-reflection feature, v2.36.0) is
                // rejected at CREATE only — legacy provider == subject rows stay fully
                // readable, editable, and transitionable (the Impact log is the replacement).
                // Since v3.1.0 a feedback may address several people: none may be the provider.
                if (feedback.providerId in feedback.subjectIds) {
                    throw BadRequestException("Feedback about yourself is not supported")
                }
                // The recipient-set rules (≤4, distinct, requested ⇒ exactly one) — also run by
                // the service's validate(), but here BEFORE the deactivation check so a
                // malformed set is reported as such rather than by a member it names twice.
                validateSubjects(feedback)
                // The optional expiresOn deadline (v3.8.0): REQUESTED-only, strict ISO, not in
                // the past. Feature-local, route-side (not FeedbackService.validate()) — mirrors
                // validateSubjects' placement, after the party guard, before the deactivation check.
                validateFeedbackExpiry(feedback.status, feedback.expiresOn)
                // After the authz guard (403 wins over 400): no NEW feedback involving a
                // deactivated party. The caller is one of them and holds a session, so this
                // can only trip on the OTHER parties — including them all is simplest.
                userService.requireNoDeactivatedUsers(
                    setOfNotNull(feedback.providerId, feedback.requesterId) + feedback.subjectIds,
                )
                val result = requireValidReferences("Referenced user does not exist") {
                    feedbackService.create(feedback)
                }
                val id = result.id
                call.response.header(HttpHeaders.Location, call.application.href(Feedbacks.Id(id = id)))
                // Best-effort side effect: deliver creation notifications after the commit.
                result.notifications.forEach { notificationService.create(it) }
                // Re-read so the response carries the server-assigned lastModified.
                val created = feedbackService.read(id) ?: feedback
                // Audit: record the creation against the acting caller.
                feedbackEventService.create(feedbackCreationEvent(created).toEvent(id, caller.userId))
                val names = feedbackService.partyNames(created)
                call.respond(
                    HttpStatusCode.Created,
                    created.toResponse(id, names, subjects = feedbackService.subjectsOf(id, created)),
                )
            }
            get<Feedbacks.Id> { route ->
                val feedback = readGuardedFeedback(call, route.id)
                val names = feedbackService.partyNames(feedback)
                call.respond(
                    HttpStatusCode.OK,
                    feedback.toResponse(
                        route.id,
                        names,
                        includeContent = canReadFeedbackContent(call.caller(), feedback),
                        subjects = feedbackService.subjectsOf(route.id, feedback),
                    ),
                )
            }
            put<Feedbacks.Id> { route ->
                val existing = writeGuardedFeedback(call, route.id)
                val edit = call.receive<FeedbackContentUpdate>()
                val updated = feedbackService.editContent(route.id, edit.content, edit.visibility)
                if (updated == 0) {
                    throw NotFoundException("Feedback not found")
                }
                // Audit: record a content/visibility edit against the caller (no status change here).
                feedbackUpdateEvent(
                    existing,
                    existing.copy(content = edit.content, visibility = edit.visibility),
                )?.let { descriptor ->
                    feedbackEventService.create(descriptor.toEvent(route.id, call.caller().userId))
                }
                call.respond(HttpStatusCode.NoContent)
            }
            post<Feedbacks.Id.Send> { route -> transitionTo(call, route.parent.id, FeedbackStatus.SENT) }
            post<Feedbacks.Id.Withdraw> { route ->
                transitionTo(call, route.parent.id, FeedbackStatus.WITHDRAWN)
            }
            post<Feedbacks.Id.Reject> { route -> transitionTo(call, route.parent.id, FeedbackStatus.REJECTED) }
            post<Feedbacks.Id.PickUp> { route -> transitionTo(call, route.parent.id, FeedbackStatus.DRAFT) }
            get<Feedbacks.Id.Events> { route ->
                val feedbackId = route.parent.id
                // Whoever may read the feedback may read its history.
                readGuardedFeedback(call, feedbackId)
                call.respond(
                    HttpStatusCode.OK,
                    FeedbackEventListResponse(feedbackEventService.listForFeedback(feedbackId)),
                )
            }
            delete<Feedbacks.Id> { route ->
                val existing = writeGuardedFeedback(call, route.id)
                // Delete is a draft-only action; other statuses have terminal transitions instead.
                if (existing.status != FeedbackStatus.DRAFT) {
                    throw BadRequestException("Only a draft feedback may be deleted")
                }
                if (feedbackService.delete(route.id) == 0) {
                    throw NotFoundException("Feedback not found")
                }
                // Best-effort side effect: tell the requester (if any) the provider deleted it (no link).
                val names = feedbackService.partyNames(existing)
                feedbackDeletionNotifications(existing, names).forEach { notificationService.create(it) }
                // Audit the deletion against the acting provider (events outlive the soft-deleted row).
                feedbackEventService.create(feedbackDeletionEvent().toEvent(route.id, call.caller().userId))
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}
