package ch.nokillswit.feedbacks

import ch.nokillswit.infra.paging.PageResponse
import ch.nokillswit.infra.parseIsoDateStrict
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import java.time.LocalDate

// Free-text limits enforced up-front (400, the validateAlert idiom) — both columns are
// unbounded `text` (encrypted at rest), so without these the only backstop would be
// request-size/memory limits. Mirrored by the SPA's maxLength caps and the spec's maxLength.
const val MAX_FEEDBACK_CONTENT_LENGTH = 5000
const val MAX_REQUESTER_MESSAGE_LENGTH = 1000

internal fun validateFeedbackTexts(content: String, requesterMessage: String? = null) {
    if (content.length > MAX_FEEDBACK_CONTENT_LENGTH) {
        throw BadRequestException("Feedback content must be at most $MAX_FEEDBACK_CONTENT_LENGTH characters")
    }
    if (requesterMessage != null && requesterMessage.length > MAX_REQUESTER_MESSAGE_LENGTH) {
        throw BadRequestException("Requester message must be at most $MAX_REQUESTER_MESSAGE_LENGTH characters")
    }
}

// A feedback may address up to four people (v3.1.0). The set is fixed at creation. KEEP IN
// SYNC with V72's `CHECK (position BETWEEN 0 AND 3)` and the spec's `maxItems` on
// `FeedbackRequest.additionalSubjectIds` (= this − 1) / `subjects` (= this) — OpenApiSpecTest
// pins the spec half; a DB CHECK violation would surface as a 500, not a client error.
const val MAX_FEEDBACK_SUBJECTS = 4

/**
 * The recipient-set rules, checked at creation only (the set is immutable afterwards — the
 * service's validate() never runs on content edits): at most [MAX_FEEDBACK_SUBJECTS] distinct
 * people, and a requested feedback (ask-for / request-for) addresses exactly one — the request
 * flows are single-recipient by design. provider ∉ subjects is the ROUTE's rule (legacy
 * self-reflection rows must stay serviceable — see FeedbackRoutes).
 */
internal fun validateSubjects(feedback: Feedback) {
    val ids = feedback.subjectIds
    if (ids.size > MAX_FEEDBACK_SUBJECTS) {
        throw BadRequestException("A feedback may have at most $MAX_FEEDBACK_SUBJECTS subjects")
    }
    if (ids.toSet().size != ids.size) throw BadRequestException("Subjects must be distinct")
    if (feedback.requesterId != null && ids.size > 1) {
        throw BadRequestException("A requested feedback must have exactly one subject")
    }
}

/**
 * The `expiresOn` rule (v3.8.0), checked at CREATE only from the route (`FeedbackRoutes.kt`,
 * after the authz guard — 403 wins over 400): meaningful only while `status == REQUESTED`, a
 * strict ISO date (`parseIsoDateStrict`), and not in the past — **minus one day of timezone
 * tolerance** (the goals/KPI/career precedent, `validateGoalDueDate` in `goals/Goal.kt`: the
 * SPA submits the BROWSER-local date while the server runs UTC, so a user behind UTC in their
 * evening legitimately sends the server's "yesterday"). Injectable [today] mirrors
 * `validateGoalDueDate`'s testability pattern. `expiresOn == null` is always fine (indefinite,
 * today's behaviour) — the field is otherwise set once and never updated
 * (`FeedbackService.update`/`editContent` omit the column, the `requesterMessage` precedent).
 */
internal fun validateFeedbackExpiry(status: FeedbackStatus, expiresOn: String?, today: LocalDate = LocalDate.now()) {
    if (expiresOn == null) return
    if (status != FeedbackStatus.REQUESTED) {
        throw BadRequestException("Expiration applies only to requested feedback")
    }
    val parsed = parseIsoDateStrict(expiresOn, "expiresOn")
    if (parsed < today.minusDays(1)) throw BadRequestException("expiresOn must not be in the past")
}

@Serializable
enum class FeedbackVisibility {
    PROVIDER_SUBJECT,
    PROVIDER_REQUESTER,
    PROVIDER_REQUESTER_SUBJECT,
    PUBLIC,
}

@Serializable
enum class FeedbackStatus { REQUESTED, DRAFT, SENT, WITHDRAWN, REJECTED }

/** Delivered = visible beyond the parties involved (subject, management chain, team lists). */
val FeedbackStatus.isDelivered: Boolean
    get() = this == FeedbackStatus.SENT || this == FeedbackStatus.WITHDRAWN

/**
 * Body of `PUT /feedbacks/{id}` — the editable representation of a feedback. Status transitions,
 * party ids, and the requester message are NOT settable here (status moves through the
 * `POST /feedbacks/{id}/{action}` endpoints; the rest are immutable after creation).
 */
@Serializable
data class FeedbackContentUpdate(
    val content: String = "",
    val visibility: FeedbackVisibility,
)

/**
 * Body of `POST /feedbacks` — mirrors the spec's FeedbackRequest exactly. Deliberately has no
 * `lastModified`: that field is server-managed, and a dedicated create DTO keeps clients from
 * even sending it (unknown keys are rejected as 400 by the default Json config).
 */
@Serializable
data class FeedbackCreateRequest(
    val requesterId: UInt? = null,
    val subjectId: UInt,
    // Further recipients in position order (v3.1.0); subjectId is always the first one.
    val additionalSubjectIds: List<UInt> = emptyList(),
    val providerId: UInt,
    val visibility: FeedbackVisibility,
    val status: FeedbackStatus,
    val content: String = "",
    val requesterMessage: String? = null,
    // Optional deadline on a REQUESTED request (v3.8.0): set once at creation, ignored by PUT
    // (the requesterMessage precedent). Meaningful only while REQUESTED — see
    // validateFeedbackExpiry.
    val expiresOn: String? = null,
) {
    fun toFeedback() = Feedback(
        requesterId = requesterId,
        subjectId = subjectId,
        additionalSubjectIds = additionalSubjectIds,
        providerId = providerId,
        visibility = visibility,
        status = status,
        content = content,
        requesterMessage = requesterMessage,
        expiresOn = expiresOn,
    )
}

@Serializable
data class Feedback(
    val requesterId: UInt? = null,
    // The first recipient — the sort/name anchor (feedbacks.subject_id); see subjectIds.
    val subjectId: UInt,
    // The further recipients in position order (v3.1.0, feedback_subjects); empty = one recipient.
    val additionalSubjectIds: List<UInt> = emptyList(),
    val providerId: UInt,
    val visibility: FeedbackVisibility,
    val status: FeedbackStatus,
    val content: String = "",
    // Requester's clarification note to the provider; set at creation only, never editable afterward.
    val requesterMessage: String? = null,
    // Optional REQUESTED-only deadline (v3.8.0, ISO date); set at creation only, never editable
    // afterward — see validateFeedbackExpiry and FeedbackService.expireOverdueRequests.
    val expiresOn: String? = null,
    // Server-managed: set on every create/update; never part of a request body (see FeedbackCreateRequest).
    val lastModified: Long = 0L,
) {
    /** Every recipient, position-ordered — the membership set every authorization question uses. */
    val subjectIds: List<UInt>
        get() = listOf(subjectId) + additionalSubjectIds
}

/** One recipient of a feedback as it rides the responses (position-ordered lists). */
@Serializable
data class FeedbackSubject(
    val id: UInt,
    val name: String,
    val deleted: Boolean = false,
)

@Serializable
data class FeedbackResponse(
    val id: UInt,
    val requesterId: UInt?,
    val subjectId: UInt,
    val providerId: UInt,
    val visibility: FeedbackVisibility,
    val status: FeedbackStatus,
    val content: String,
    val requesterMessage: String? = null,
    // Optional REQUESTED-only deadline (v3.8.0). Null = indefinite, or the request already left
    // REQUESTED (the value is inert past that point — see validateFeedbackExpiry).
    val expiresOn: String? = null,
    val lastModified: Long,
    // Resolved party display names; null when not resolved (e.g. no requester).
    val requesterName: String? = null,
    val subjectName: String? = null,
    val providerName: String? = null,
    // Every recipient in position order; subjects[0] is subjectId/subjectName (v3.1.0).
    val subjects: List<FeedbackSubject> = emptyList(),
)

fun Feedback.toResponse(
    id: UInt,
    names: Map<UInt, String> = emptyMap(),
    includeContent: Boolean = true,
    subjects: List<FeedbackSubject>? = null,
) =
    FeedbackResponse(
        id, requesterId, subjectId, providerId, visibility, status,
        content = if (includeContent) content else "",
        requesterMessage = requesterMessage,
        expiresOn = expiresOn,
        lastModified = lastModified,
        requesterName = requesterId?.let { names[it] },
        subjectName = names[subjectId],
        providerName = names[providerId],
        subjects = subjects ?: subjectIds.map { FeedbackSubject(it, names[it] ?: "#$it") },
    )

@Serializable
data class FeedbackListItem(
    val id: UInt,
    val requesterId: UInt?,
    val requesterName: String?,
    val requesterDeleted: Boolean,
    val subjectId: UInt,
    val subjectName: String,
    val subjectDeleted: Boolean,
    // Every recipient in position order; subjects[0] is the subjectId/subjectName pair (v3.1.0).
    val subjects: List<FeedbackSubject> = emptyList(),
    val providerId: UInt,
    val providerName: String,
    val providerDeleted: Boolean,
    val visibility: FeedbackVisibility,
    val status: FeedbackStatus,
    // Optional REQUESTED-only deadline (v3.8.0) — see FeedbackResponse.expiresOn.
    val expiresOn: String? = null,
    val contentPreview: String,
    // Full (uncapped) content — populated for view=kudos only, whose wall expands cards inline;
    // every kudos row is PUBLIC+SENT, so this never widens what the caller may read.
    // EncodeDefault(NEVER) OMITS the key on every other view (the users-list `teams` idiom).
    @OptIn(ExperimentalSerializationApi::class)
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val content: String? = null,
    val lastModified: Long,
)

typealias FeedbackPageResponse = PageResponse<FeedbackListItem>

/**
 * GET /api/v1/feedbacks/duplicate-check: the in-progress duplicate for a prospective
 * (subject, provider, requester) triple, if any — both fields null when there is none.
 * Backs the SPA's early warning on the create screens.
 */
@Serializable
data class DuplicateCheckResponse(
    val existingId: UInt?,
    val existingStatus: FeedbackStatus?,
)
