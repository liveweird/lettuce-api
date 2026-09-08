package ch.nokillswit.feedbacks

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.crypto.EncryptedAtRest
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.infra.crypto.reencryptRows
import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.infra.db.decodeParams
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.notifications.Notification
import ch.nokillswit.teams.directManagerIds
import ch.nokillswit.teams.directSubordinateIds
import ch.nokillswit.teams.isInManagementChain
import ch.nokillswit.teams.transitiveSubordinateIds
import ch.nokillswit.users.UserService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import java.time.LocalDate
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.singleOrNull
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.EntityID
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val FeedbackServiceKey = AttributeKey<FeedbackService>("FeedbackService")

enum class FeedbackListView { RECEIVED, PROVIDED, TEAM, USER, KUDOS }

data class FeedbackListFilter(
    val requesterName: String? = null,
    val subjectName: String? = null,
    val providerName: String? = null,
    val providerId: UInt? = null,
    val subjectId: UInt? = null,
    val visibility: FeedbackVisibility? = null,
    val status: FeedbackStatus? = null,
    val lastModifiedGte: Long? = null,
)

data class FeedbackListResult(
    val items: List<FeedbackListItem>,
    val total: Long,
)

data class FeedbackCreateResult(
    val id: UInt,
    val notifications: List<Notification>,
)

/**
 * One row flipped by [FeedbackService.expireOverdueRequests] — the caller (the feedback list
 * route) persists these exactly like the manual `POST …/reject` path: the notifications via
 * `NotificationService.create`, then the event via `feedbackExpiryEvent().toEvent(feedbackId,
 * providerId)` (`feedback_events.user_id` is `NOT NULL`, so the event is attributed to the
 * provider — see `feedbackExpiryEvent`).
 */
data class ExpiredOutcome(
    val feedbackId: UInt,
    val providerId: UInt,
    val notifications: List<Notification>,
)

private val requesterUsers = UserService.Users.alias("requester_users")
private val subjectUsers = UserService.Users.alias("subject_users")
private val providerUsers = UserService.Users.alias("provider_users")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to FeedbackService.Feedbacks.id,
    "requesterName" to requesterUsers[UserService.Users.name],
    "subjectName" to subjectUsers[UserService.Users.name],
    "providerName" to providerUsers[UserService.Users.name],
    "visibility" to FeedbackService.Feedbacks.visibility,
    "status" to FeedbackService.Feedbacks.status,
    "lastModified" to FeedbackService.Feedbacks.lastModified,
)

// The Received scope mirrors canReadFeedback's subject/requester branches (authz/Guards.kt) so
// the list never shows a row the single GET would 403 on.
private val SUBJECT_VISIBILITIES = listOf(
    FeedbackVisibility.PROVIDER_SUBJECT,
    FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
)
private val REQUESTER_VISIBILITIES = listOf(
    FeedbackVisibility.PROVIDER_REQUESTER,
    FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
)

// A feedback the caller is not a party to (Received / My team lists) is only shown once delivered.
private val DELIVERED_STATUSES = FeedbackStatus.entries.filter { it.isDelivered }

// "In progress" for the no-duplicate invariant: a second feedback with the same
// (subject, provider, requester) triple may not be created while one of these exists.
private val OPEN_STATUSES = listOf(FeedbackStatus.DRAFT, FeedbackStatus.REQUESTED)

const val CONTENT_PREVIEW_LENGTH = 200

// content/requester_message are encrypted at rest (see infra/crypto/FieldCipher.kt): the cipher
// wraps every write and unwraps every read, so nothing above this service ever sees ciphertext.
// Neither column is filtered/sorted/searched in SQL, so queries are unaffected.
class FeedbackService(val database: R2dbcDatabase, private val cipher: FieldCipher) : EncryptedAtRest {
    override val encryptedRowLabel = "feedback"

    object Feedbacks : UIntIdTable("feedbacks") {
        val requesterId = reference("requester_id", UserService.Users).nullable()
        val subjectId = reference("subject_id", UserService.Users)
        val providerId = reference("provider_id", UserService.Users)
        val visibility = enumerationByName("visibility", 40, FeedbackVisibility::class)
        val status = enumerationByName("status", 20, FeedbackStatus::class)
        val content = text("content")
        val requesterMessage = text("requester_message").nullable()
        // Optional REQUESTED-only deadline (v3.8.0, V76). Set once at creation, never updated
        // (the requesterMessage precedent) — see validateFeedbackExpiry and
        // expireOverdueRequests.
        val expiresOn = varchar("expires_on", 10).nullable()
        val lastModified = long("last_modified")
        val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /**
     * The recipient set (v3.1.0, V72): position-ordered, fixed at creation. `Feedbacks.subjectId`
     * is by construction the position-0 row and stays the sort/name anchor; every membership
     * question goes through [subjectIn].
     */
    object FeedbackSubjects : Table("feedback_subjects") {
        val feedbackId = reference("feedback_id", Feedbacks)
        val userId = reference("user_id", UserService.Users)
        val position = integer("position")
        override val primaryKey = PrimaryKey(feedbackId, userId)
    }

    private fun active(): Op<Boolean> = Feedbacks.markedAsDeleted eq false

    /**
     * Rows whose recipient set contains ANY of [userIds]: the position-0 anchor column OR the join
     * table (the anchor keeps the single-recipient majority on the subject_id index, and rows
     * inserted below [create] — legacy/test seeds without join rows — stay visible).
     */
    private fun subjectIn(userIds: Collection<UInt>): Op<Boolean> =
        (Feedbacks.subjectId inList userIds) or
            (
                Feedbacks.id inSubQuery FeedbackSubjects.select(FeedbackSubjects.feedbackId)
                    .where { FeedbackSubjects.userId inList userIds }
            )

    private fun isSubject(userId: UInt): Op<Boolean> = subjectIn(listOf(userId))

    /**
     * Inserts the feedback and returns its id together with any notifications its creation should
     * produce (currently only a brand-new REQUESTED feedback notifies the provider). The caller
     * persists them, mirroring [transition].
     */
    suspend fun create(feedback: Feedback): FeedbackCreateResult = suspendTransaction(database) {
        // NOTE: provider ∈ subjects (the retired self-reflection shape, v2.36.0) is rejected by
        // the ROUTE's create handler, deliberately not here — the service stays able to carry
        // legacy rows (and tests seed them through it). validate() runs on CREATE only:
        // editContent deliberately re-checks just the texts and the visibility coherence, so a
        // pre-existing self row (or any legacy party set) stays editable.
        validate(feedback)
        // No-duplicate invariant, per recipient: while a feedback by the same provider for the
        // same requester that includes ANY of the new recipients is still in progress (DRAFT or
        // REQUESTED), a second one may not be created — finish or discard the existing one
        // instead (the 409's instance points at it).
        findOpenDuplicateInTx(feedback.subjectIds, feedback.providerId, feedback.requesterId)?.let { (dupId, _) ->
            throw ConflictException(
                "A feedback for this subject, provider and requester is already in progress",
                instance = "/api/v1/feedbacks/$dupId",
            )
        }
        val newRecord = Feedbacks.insert {
            it[requesterId] = feedback.requesterId
            it[subjectId] = feedback.subjectId
            it[providerId] = feedback.providerId
            it[visibility] = feedback.visibility
            it[status] = feedback.status
            it[content] = cipher.encrypt(feedback.content)
            it[requesterMessage] = feedback.requesterMessage?.let(cipher::encrypt)
            it[expiresOn] = feedback.expiresOn
            it[lastModified] = System.currentTimeMillis()
        }
        val id = newRecord[Feedbacks.id].value
        feedback.subjectIds.forEachIndexed { index, userId ->
            FeedbackSubjects.insert {
                it[feedbackId] = id
                it[FeedbackSubjects.userId] = userId
                it[position] = index
            }
        }
        // The pure mapping decides per status (REQUESTED and direct-SENT notify; DRAFT doesn't).
        val managers = resolveSubjectManagers(feedback)
        val notifications = feedbackCreationNotifications(
            id,
            feedback,
            resolvePartyNames(feedback),
            subjectManagerNames = managers.names,
            recipientsByManager = managers.recipientsByManager,
        )
        FeedbackCreateResult(id, notifications)
    }

    // Single source for row → Feedback; shared by read() and the current-state read in update().
    private fun ResultRow.toFeedback(): Feedback = Feedback(
        requesterId = this[Feedbacks.requesterId]?.value,
        subjectId = this[Feedbacks.subjectId].value,
        providerId = this[Feedbacks.providerId].value,
        visibility = this[Feedbacks.visibility],
        status = this[Feedbacks.status],
        content = cipher.decrypt(this[Feedbacks.content]),
        requesterMessage = this[Feedbacks.requesterMessage]?.let(cipher::decrypt),
        expiresOn = this[Feedbacks.expiresOn],
        lastModified = this[Feedbacks.lastModified],
    )

    /**
     * The active row as a [Feedback] with its full recipient set (the join rows beyond the
     * anchor, position-ordered); null when missing/deleted. Must run inside the caller's
     * transaction — every read path funnels through it so guards and notifications always see
     * every recipient.
     */
    private suspend fun readInTx(id: UInt): Feedback? {
        val row = Feedbacks.selectAll()
            .where { (Feedbacks.id eq id) and active() }
            .map { it.toFeedback() }
            .singleOrNull()
            ?: return null
        return row.copy(additionalSubjectIds = additionalSubjectIdsOf(id, row.subjectId))
    }

    // A row inserted below create() (legacy/test seeds) has no join rows → empty, i.e. the
    // anchor alone — the same fallback the list and subjectsOf apply.
    private suspend fun additionalSubjectIdsOf(feedbackId: UInt, anchor: UInt): List<UInt> =
        FeedbackSubjects.select(FeedbackSubjects.userId)
            .where { FeedbackSubjects.feedbackId eq feedbackId }
            .orderBy(FeedbackSubjects.position to SortOrder.ASC)
            .map { it[FeedbackSubjects.userId].value }
            .toList()
            .filter { it != anchor }

    suspend fun read(id: UInt): Feedback? = suspendTransaction(database) { readInTx(id) }

    /**
     * The recipient list as it rides the responses (names + soft-delete flags, position order)
     * for one feedback: the anchor (`feedbacks.subject_id`, resolved here with its soft-delete
     * flag) always first, then the join rows — the same "anchor OR join" rule every membership
     * predicate uses, so what a response SHOWS can never disagree with what the guard GRANTS.
     */
    suspend fun subjectsOf(id: UInt, feedback: Feedback): List<FeedbackSubject> =
        suspendTransaction(database) {
            val anchor = UserService.Users
                .select(UserService.Users.name, UserService.Users.markedAsDeleted)
                .where { UserService.Users.id eq feedback.subjectId }
                .map { FeedbackSubject(feedback.subjectId, it[UserService.Users.name], it[UserService.Users.markedAsDeleted]) }
                .singleOrNull()
                ?: FeedbackSubject(feedback.subjectId, "#${feedback.subjectId}")
            anchorFirst(anchor, subjectsByFeedbackIds(listOf(id))[id].orEmpty())
        }

    /** The anchor at position 0 (whether or not the join rows carry it), then the rest in order. */
    private fun anchorFirst(anchor: FeedbackSubject, joined: List<FeedbackSubject>): List<FeedbackSubject> =
        listOf(anchor) + joined.filter { it.id != anchor.id }

    /** feedback id → its join-row recipients (position-ordered), one grouped query per batch. */
    private suspend fun subjectsByFeedbackIds(ids: Collection<UInt>): Map<UInt, List<FeedbackSubject>> {
        if (ids.isEmpty()) return emptyMap()
        return FeedbackSubjects
            .join(
                UserService.Users,
                JoinType.INNER,
                onColumn = FeedbackSubjects.userId,
                otherColumn = UserService.Users.id,
            )
            .select(
                FeedbackSubjects.feedbackId,
                UserService.Users.id,
                UserService.Users.name,
                UserService.Users.markedAsDeleted,
            )
            .where { FeedbackSubjects.feedbackId inList ids.toList() }
            .orderBy(FeedbackSubjects.feedbackId to SortOrder.ASC, FeedbackSubjects.position to SortOrder.ASC)
            .map { row ->
                row[FeedbackSubjects.feedbackId].value to FeedbackSubject(
                    id = row[UserService.Users.id].value,
                    name = row[UserService.Users.name],
                    deleted = row[UserService.Users.markedAsDeleted],
                )
            }
            .toList()
            .groupBy({ it.first }, { it.second })
    }

    /**
     * Edits a feedback's content/visibility (never its status, parties, or requester message).
     * Returns the affected-row count (0 → missing/deleted, mapped to 404 by the route).
     */
    suspend fun editContent(id: UInt, content: String, visibility: FeedbackVisibility): Int {
        validateFeedbackTexts(content)
        return suspendTransaction(database) {
            val current = readInTx(id) ?: return@suspendTransaction 0
            requireCoherentVisibility(current.requesterId, visibility)
            Feedbacks.update({ (Feedbacks.id eq id) and (Feedbacks.markedAsDeleted eq false) }) {
                it[this.content] = cipher.encrypt(content)
                it[this.visibility] = visibility
                it[lastModified] = System.currentTimeMillis()
            }
        }
    }

    /**
     * Moves a feedback to [target] via the status state machine and returns the notifications the
     * transition should produce (the caller persists them). Returns null when the row is missing
     * (→ 404); throws [ConflictException] (→ 409) when the transition is not allowed from the
     * current status, OR when the UPDATE below affects zero rows because a concurrent call already
     * moved the row out of the status this call observed (e.g. a pick-up racing a reject) — the
     * domain-guard retry shape: the caller re-reads and either retries or gives up, never silently
     * overwriting a status nobody chose.
     */
    suspend fun transition(id: UInt, target: FeedbackStatus): List<Notification>? {
        return suspendTransaction(database) {
            val current = readInTx(id) ?: return@suspendTransaction null
            if (!isAllowedTransition(current.status, target)) {
                throw ConflictException("Invalid status transition: ${current.status} -> $target")
            }
            if (target == FeedbackStatus.DRAFT) {
                // Pick-up guard: a request may not become a second draft when a matching one
                // already exists (reachable only with duplicates predating the create-time
                // no-duplicate invariant).
                findOpenDuplicateInTx(
                    current.subjectIds,
                    current.providerId,
                    current.requesterId,
                    statuses = listOf(FeedbackStatus.DRAFT),
                )?.let { (dupId, _) ->
                    throw ConflictException(
                        "A draft for this subject, provider and requester already exists",
                        instance = "/api/v1/feedbacks/$dupId",
                    )
                }
            }
            // The status predicate is load-bearing: without it, a transition racing another one
            // from the SAME observed current.status (e.g. two REQUESTED->* actions) would blindly
            // overwrite whatever the other one just wrote instead of losing the race.
            val updated = Feedbacks.update({
                (Feedbacks.id eq id) and (Feedbacks.markedAsDeleted eq false) and (Feedbacks.status eq current.status)
            }) {
                it[status] = target
                it[lastModified] = System.currentTimeMillis()
            }
            if (updated == 0) {
                throw ConflictException("Feedback status changed concurrently; retry")
            }
            val next = current.copy(status = target)
            val managers = resolveSubjectManagers(next)
            feedbackTransitionNotifications(
                id,
                current.status,
                next,
                resolvePartyNames(next),
                subjectManagerNames = managers.names,
                recipientsByManager = managers.recipientsByManager,
            )
        }
    }

    /**
     * The lazy expiry sweep (v3.8.0 — no background job): flips every active `REQUESTED` row
     * whose `expiresOn` deadline has passed (`expires_on < today`, ISO string compare —
     * lexicographic == chronological) to `REJECTED`, bumping `lastModified`, and returns one
     * [ExpiredOutcome] per row the UPDATE below actually flipped, for the caller (the feedback
     * list route) to persist exactly like the manual `POST …/reject` path. Built via
     * `updateReturning` rather than a separate SELECT-then-UPDATE: the outcome list is derived
     * ONLY from the rows the database actually locked and flipped inside this `suspendTransaction`,
     * so a row a concurrent transition (e.g. a pick-up) moves out of `REQUESTED` between two
     * otherwise-independent calls is simply absent from the result — never a false expiry event/
     * notification for a row that is no longer overdue-REQUESTED by the time it is touched.
     * Idempotent — a row already flipped no longer matches the `REQUESTED` predicate, so a second
     * call returns nothing for it. [today] is injectable, the `validateGoalDueDate` testability
     * pattern.
     */
    suspend fun expireOverdueRequests(today: LocalDate = LocalDate.now()): List<ExpiredOutcome> =
        suspendTransaction(database) {
            val todayIso = today.toString()
            // Materialize the returning rows FIRST (closing that result cursor) before running
            // any further query below — resolvePartyNames() must not interleave with an open
            // result stream on the same connection.
            val flipped = Feedbacks.updateReturning(
                returning = listOf(
                    Feedbacks.id,
                    Feedbacks.requesterId,
                    Feedbacks.subjectId,
                    Feedbacks.providerId,
                    Feedbacks.visibility,
                ),
                where = {
                    (Feedbacks.status eq FeedbackStatus.REQUESTED) and
                        Feedbacks.expiresOn.isNotNull() and
                        (Feedbacks.expiresOn less todayIso) and
                        active()
                },
            ) {
                it[status] = FeedbackStatus.REJECTED
                it[lastModified] = System.currentTimeMillis()
            }.toList()

            flipped.map { row ->
                // A REQUESTED feedback is always single-recipient (validateSubjects), so the
                // anchor subjectId is the whole recipient set — no join-table read needed. status
                // is REQUESTED by construction (the WHERE clause above), not selected again.
                val feedback = Feedback(
                    requesterId = row[Feedbacks.requesterId]?.value,
                    subjectId = row[Feedbacks.subjectId].value,
                    providerId = row[Feedbacks.providerId].value,
                    visibility = row[Feedbacks.visibility],
                    status = FeedbackStatus.REQUESTED,
                )
                val names = resolvePartyNames(feedback)
                ExpiredOutcome(
                    feedbackId = row[Feedbacks.id].value,
                    providerId = feedback.providerId,
                    notifications = listOf(
                        feedbackExpiredToRequesterNotification(feedback, names),
                        feedbackExpiredToProviderNotification(feedback, names),
                    ),
                )
            }
        }

    /** The recipients' direct managers: id → name, plus which recipients each one manages. */
    private data class SubjectManagers(
        val names: Map<UInt, String>,
        val recipientsByManager: Map<UInt, Set<UInt>>,
    ) {
        companion object {
            val NONE = SubjectManagers(emptyMap(), emptyMap())
        }
    }

    /**
     * The direct managers of EVERY recipient, resolved only when the feedback lands in SENT (the
     * moment they gain read access — see feedbackTransitionNotifications); empty otherwise, so
     * non-SENT paths pay no extra queries. One chain query per recipient (≤4 by rule — the
     * per-recipient grouping is what the manager notes need). Soft-deleted managers are skipped.
     */
    private suspend fun resolveSubjectManagers(feedback: Feedback): SubjectManagers {
        if (feedback.status != FeedbackStatus.SENT) return SubjectManagers.NONE
        val recipientsByManager = mutableMapOf<UInt, MutableSet<UInt>>()
        feedback.subjectIds.forEach { subjectId ->
            directManagerIds(subjectId).forEach { managerId ->
                recipientsByManager.getOrPut(managerId) { mutableSetOf() } += subjectId
            }
        }
        if (recipientsByManager.isEmpty()) return SubjectManagers.NONE
        val names = UserService.Users
            .select(UserService.Users.id, UserService.Users.name)
            .where {
                (UserService.Users.id inList recipientsByManager.keys) and
                    (UserService.Users.markedAsDeleted eq false)
            }
            .map { it[UserService.Users.id].value to it[UserService.Users.name] }
            .toList()
            .toMap()
        return SubjectManagers(names, recipientsByManager)
    }

    /**
     * The in-progress duplicate of a prospective feedback, if any: the oldest active row in
     * DRAFT or REQUESTED status by the same provider for the same requester (a null requester
     * matches only null) whose recipient set includes the subject — per recipient, so an open
     * multi-recipient draft blocks a new single one for any of its people and vice versa. Backs
     * the create/pick-up no-duplicate invariant and the `duplicate-check` endpoint's early
     * warning (single-subject: the SPA probes once per picked recipient). Returns id + status.
     */
    suspend fun findOpenDuplicate(
        subjectId: UInt,
        providerId: UInt,
        requesterId: UInt?,
    ): Pair<UInt, FeedbackStatus>? =
        suspendTransaction(database) { findOpenDuplicateInTx(listOf(subjectId), providerId, requesterId) }

    private suspend fun findOpenDuplicateInTx(
        subjectIds: Collection<UInt>,
        providerId: UInt,
        requesterId: UInt?,
        statuses: List<FeedbackStatus> = OPEN_STATUSES,
    ): Pair<UInt, FeedbackStatus>? =
        Feedbacks
            .select(Feedbacks.id, Feedbacks.status)
            .where {
                subjectIn(subjectIds) and
                    (Feedbacks.providerId eq providerId) and
                    (
                        if (requesterId == null) Feedbacks.requesterId.isNull()
                        else Feedbacks.requesterId eq requesterId
                    ) and
                    (Feedbacks.status inList statuses) and
                    active()
            }
            .orderBy(Feedbacks.id to SortOrder.ASC)
            .limit(1)
            .map { it[Feedbacks.id].value to it[Feedbacks.status] }
            .singleOrNull()

    /** Transaction-wrapped variant for callers outside an open transaction (e.g. routes). */
    suspend fun partyNames(feedback: Feedback): Map<UInt, String> =
        suspendTransaction(database) { resolvePartyNames(feedback) }

    private suspend fun resolvePartyNames(feedback: Feedback): Map<UInt, String> {
        val ids = feedback.subjectIds + listOfNotNull(feedback.providerId, feedback.requesterId)
        return UserService.Users
            .select(UserService.Users.id, UserService.Users.name)
            .where { UserService.Users.id inList ids }
            .map { it[UserService.Users.id].value to it[UserService.Users.name] }
            .toList()
            .toMap()
    }

    suspend fun delete(id: UInt): Int = suspendTransaction(database) {
        Feedbacks.update({ (Feedbacks.id eq id) and (Feedbacks.markedAsDeleted eq false) }) {
            it[markedAsDeleted] = true
        }
    }

    /**
     * Startup backfill (see infra/db/Bootstrap.kt): encrypts rows still holding legacy plaintext
     * — including soft-deleted ones, which retain their content. With [reencryptAll] (set during
     * key rotation, i.e. while a previous key is configured) every row is decrypted (current or
     * previous key) and rewritten under the current key. Idempotent; returns the rewritten count.
     */
    override suspend fun encryptLegacyRows(reencryptAll: Boolean): Int = suspendTransaction(database) {
        cipher.reencryptRows(Feedbacks, listOf(Feedbacks.content, Feedbacks.requesterMessage), reencryptAll)
    }

    /**
     * The Received-list visibility scope for [callerUserId] — the caller's inbox (the caller is
     * one of the recipients), scoped exactly like canReadFeedback (authz/Guards.kt) so every
     * listed row is also openable:
     * - as the requester of their own feedback: any status under a requester-readable visibility
     *   (an unfinished one has its content preview redacted in list());
     * - as a plain subject (no requester, or someone else's request): only once delivered
     *   (SENT/WITHDRAWN) under a subject-readable visibility;
     * - PUBLIC rows in either role: only once SENT (the "anyone" rule).
     * Shared by [list] and [lastProvidedAt] so the two can never drift apart.
     */
    private fun receivedScope(callerUserId: UInt): Op<Boolean> {
        val publicSent = (Feedbacks.visibility eq FeedbackVisibility.PUBLIC) and
            (Feedbacks.status eq FeedbackStatus.SENT)
        val iAmRequester = (Feedbacks.requesterId eq callerUserId) and
            ((Feedbacks.visibility inList REQUESTER_VISIBILITIES) or publicSent)
        val asSubjectOnly =
            (Feedbacks.requesterId.isNull() or (Feedbacks.requesterId neq callerUserId)) and
                (
                    ((Feedbacks.visibility inList SUBJECT_VISIBILITIES) and
                        (Feedbacks.status inList DELIVERED_STATUSES)) or publicSent
                )
        return isSubject(callerUserId) and (iAmRequester or asSubjectOnly)
    }

    /**
     * For each provider in [providerIds], the epoch-ms moment they last provided [subjectId]
     * feedback: the newest SENT transition among their currently-SENT, non-deleted feedbacks about
     * the subject that the subject can see under the Received scoping (never leaks an invisible
     * feedback). Providers with no qualifying feedback are absent from the map.
     */
    suspend fun lastProvidedAt(providerIds: Set<UInt>, subjectId: UInt): Map<UInt, Long> =
        if (providerIds.isEmpty()) emptyMap()
        else lastSentAtBy(
            Feedbacks.providerId,
            (Feedbacks.providerId inList providerIds) and receivedScope(subjectId),
        )

    /**
     * The provider-side mirror of [lastProvidedAt]: for each subject in [subjectIds], the epoch-ms
     * moment [providerId] last provided them feedback, keyed by subject. No Received scoping — the
     * caller is the provider and always sees their own feedback, so a row whose visibility hides
     * it from the subject (e.g. PROVIDER_REQUESTER) still counts. Self-reflections (provider ==
     * subject) would qualify, but neither consumer (the managed and member team views) ever
     * lists the caller themselves. A multi-recipient feedback counts for EACH of its recipients
     * (keyed through the join table). Subjects with no qualifying feedback are absent from the map.
     */
    suspend fun lastProvidedTo(providerId: UInt, subjectIds: Set<UInt>): Map<UInt, Long> {
        if (subjectIds.isEmpty()) return emptyMap()
        // The anchor OR join rule, as two keyed queries merged by max: the anchor column keeps
        // rows without join rows (the legacy/test shape) counting, the join adds the further
        // recipients of a multi-recipient feedback.
        val byAnchor = lastSentAtBy(
            Feedbacks.subjectId,
            (Feedbacks.providerId eq providerId) and (Feedbacks.subjectId inList subjectIds),
        )
        val byJoin = lastSentAtBy(
            FeedbackSubjects.userId,
            (Feedbacks.providerId eq providerId) and (FeedbackSubjects.userId inList subjectIds),
            source = Feedbacks.join(
                FeedbackSubjects,
                JoinType.INNER,
                onColumn = Feedbacks.id,
                otherColumn = FeedbackSubjects.feedbackId,
            ),
        )
        return (byAnchor.keys + byJoin.keys).associateWith { maxOf(byAnchor[it] ?: 0L, byJoin[it] ?: 0L) }
    }

    /**
     * Per [keyColumn] value, the newest SENT moment among the currently-SENT, non-deleted
     * feedbacks matching [scope] over [source] (the feedbacks table, or a join onto it whose
     * key column multiplies a feedback per recipient). SENT is reachable at most once per
     * feedback (SENT → WITHDRAWN is terminal), so "the" SENT event is well-defined. Feedbacks
     * predating the events table (pre-V15) have no SENT event and fall back to lastModified —
     * an upper bound of the true sent moment (content edits bump it), better than a false "never".
     */
    private suspend fun lastSentAtBy(
        keyColumn: Column<EntityID<UInt>>,
        scope: Op<Boolean>,
        source: ColumnSet = Feedbacks,
    ): Map<UInt, Long> =
        suspendTransaction(database) {
            val candidates = source
                .select(Feedbacks.id, keyColumn, Feedbacks.lastModified)
                .where { scope and (Feedbacks.status eq FeedbackStatus.SENT) and active() }
                .map { Triple(it[Feedbacks.id].value, it[keyColumn].value, it[Feedbacks.lastModified]) }
                .toList()
            if (candidates.isEmpty()) return@suspendTransaction emptyMap()

            // A joined source repeats a feedback per recipient — dedupe the id list.
            val sentAt = sentMoments(candidates.mapTo(mutableSetOf()) { it.first })

            candidates
                .groupBy({ it.second }) { sentAt[it.first] ?: it.third } // pre-V15 fallback: lastModified
                .mapValues { (_, times) -> times.max() }
        }

    /**
     * How many delivered (currently SENT, non-deleted) feedbacks in [callerUserId]'s received
     * scope have their SENT moment in `[fromMs, toMs)`. The moment resolves like [lastSentAtBy]
     * (audit-trail event, pre-V15 fallback to lastModified). Backs the Dashboard hero's
     * received-30d tile and its previous-window delta — candidates-first, so the event query
     * stays on the indexed feedback_id.
     */
    suspend fun receivedSentCount(callerUserId: UInt, fromMs: Long, toMs: Long): Long =
        suspendTransaction(database) {
            val candidates = Feedbacks
                .select(Feedbacks.id, Feedbacks.lastModified)
                .where {
                    receivedScope(callerUserId) and (Feedbacks.status eq FeedbackStatus.SENT) and active()
                }
                .map { it[Feedbacks.id].value to it[Feedbacks.lastModified] }
                .toList()
                .toMap()
            if (candidates.isEmpty()) return@suspendTransaction 0L

            val sentAt = sentMoments(candidates.keys)
            candidates.entries.count { (id, lastModified) ->
                (sentAt[id] ?: lastModified) in fromMs until toMs
            }.toLong()
        }

    /**
     * Per feedback id, its SENT moment from the audit trail: STATUS_CHANGED{to=SENT} or a
     * feedback CREATED directly as SENT. Params are opaque JSON text decoded Kotlin-side (the
     * repo has no SQL JSON operators); the per-feedback event volume is tiny. Ids with no SENT
     * event (pre-V15 rows) are absent — callers fall back to lastModified. Must run inside the
     * caller's transaction.
     */
    private suspend fun sentMoments(feedbackIds: Collection<UInt>): Map<UInt, Long> {
        val events = FeedbackEventService.FeedbackEvents
        val sentAt = mutableMapOf<UInt, Long>()
        events.select(events.feedbackId, events.timestamp, events.eventType, events.params)
            .where {
                (events.feedbackId inList feedbackIds.toList()) and
                    (
                        events.eventType inList listOf(
                            FeedbackEventType.STATUS_CHANGED.name,
                            FeedbackEventType.CREATED.name,
                        )
                    )
            }
            .toList()
            .forEach { row ->
                val params = decodeParams(row[events.params])
                val isSent = when (row[events.eventType]) {
                    FeedbackEventType.STATUS_CHANGED.name -> params["to"] == FeedbackStatus.SENT.name
                    else -> params["status"] == FeedbackStatus.SENT.name
                }
                if (isSent) sentAt.merge(row[events.feedbackId].value, row[events.timestamp], ::maxOf)
            }
        return sentAt
    }

    suspend fun list(
        view: FeedbackListView,
        callerUserId: UInt,
        filter: FeedbackListFilter,
        paging: PageRequest,
        includeIndirect: Boolean = false,
        targetUserId: UInt? = null,
    ): FeedbackListResult = suspendTransaction(database) {
        val scope = viewScope(view, callerUserId, includeIndirect, targetUserId)
        val predicate: Op<Boolean> = scope and buildPredicate(filter) and active()
        val join = Feedbacks
            .join(
                subjectUsers,
                JoinType.INNER,
                onColumn = Feedbacks.subjectId,
                otherColumn = subjectUsers[UserService.Users.id],
            )
            .join(
                providerUsers,
                JoinType.INNER,
                onColumn = Feedbacks.providerId,
                otherColumn = providerUsers[UserService.Users.id],
            )
            .join(
                requesterUsers,
                JoinType.LEFT,
                onColumn = Feedbacks.requesterId,
                otherColumn = requesterUsers[UserService.Users.id],
            )
        val total = join.selectAll().where { predicate }.count()
        val rows = join
            .select(
                Feedbacks.id,
                Feedbacks.requesterId,
                Feedbacks.subjectId,
                Feedbacks.providerId,
                Feedbacks.visibility,
                Feedbacks.status,
                Feedbacks.expiresOn,
                Feedbacks.content,
                Feedbacks.lastModified,
                requesterUsers[UserService.Users.name],
                requesterUsers[UserService.Users.markedAsDeleted],
                subjectUsers[UserService.Users.name],
                subjectUsers[UserService.Users.markedAsDeleted],
                providerUsers[UserService.Users.name],
                providerUsers[UserService.Users.markedAsDeleted],
            )
            .where { predicate }
            .applyPaging(paging, SORTABLE_COLUMNS)
            .map { row -> row.toListItem(view, callerUserId) }
            .toList()
        // The recipient lists, one grouped query per page (the users-list `teams` idiom): the
        // anchor (already on the row from the alias join) first, then the join rows.
        val subjects = subjectsByFeedbackIds(rows.map { it.id })
        val items = rows.map { row ->
            row.copy(
                subjects = anchorFirst(
                    FeedbackSubject(row.subjectId, row.subjectName, row.subjectDeleted),
                    subjects[row.id].orEmpty(),
                ),
            )
        }
        FeedbackListResult(items = items, total = total)
    }

    /** The per-view row scope of [list]; runs in the caller's transaction (the chain walks). */
    private suspend fun viewScope(
        view: FeedbackListView,
        callerUserId: UInt,
        includeIndirect: Boolean,
        targetUserId: UInt?,
    ): Op<Boolean> =
        when (view) {
            FeedbackListView.RECEIVED -> receivedScope(callerUserId)
            FeedbackListView.PROVIDED -> Feedbacks.providerId eq callerUserId
            FeedbackListView.USER -> {
                // Auditor view (HR-only, gated route-side via requireAuditListAccess): every
                // feedback the target is a party to, at every status and visibility.
                // The route guarantees a non-null userId.
                val target = requireNotNull(targetUserId) { "view=user requires userId" }
                isSubject(target) or
                    (Feedbacks.providerId eq target) or
                    (Feedbacks.requesterId eq target)
            }
            FeedbackListView.KUDOS -> {
                // The org-wide Kudos wall: exactly the rows canReadFeedback's PUBLIC+SENT branch
                // already grants every authenticated caller, so the scope needs no caller anchor.
                (Feedbacks.visibility eq FeedbackVisibility.PUBLIC) and
                    (Feedbacks.status eq FeedbackStatus.SENT)
            }
            FeedbackListView.TEAM -> {
                // Direct reports by default; with includeIndirect the whole transitive
                // management chain (members of teams the caller manages, plus recursively
                // the members of teams those members manage).
                val subordinateIds =
                    if (includeIndirect) transitiveSubordinateIds(callerUserId)
                    else directSubordinateIds(callerUserId)
                // I see a subordinate's feedback (any recipient of it is my subordinate) if I'm
                // a party (provider or requester) for any status; otherwise only once it's
                // delivered (SENT/WITHDRAWN).
                val iAmParty = (Feedbacks.providerId eq callerUserId) or
                    (Feedbacks.requesterId eq callerUserId)
                if (subordinateIds.isEmpty()) {
                    Op.FALSE
                } else {
                    subjectIn(subordinateIds) and
                        (iAmParty or (Feedbacks.status inList DELIVERED_STATUSES))
                }
            }
        }

    // The list row mapping (the `subjects` list is attached afterwards, per page).
    private fun ResultRow.toListItem(view: FeedbackListView, callerUserId: UInt): FeedbackListItem {
        val row = this
        // Mirror canReadFeedbackContent: a requester watching an unfinished feedback sees
        // that it exists but not its content. The provider short-circuit matches the
        // guard's — today it is unreachable (validate() rejects requesterId == providerId),
        // but the redaction must not silently depend on that distant invariant. The auditor
        // view is never redacted — the HR read includes content (canReadFeedbackContent);
        // this is deliberately NARROWER than the guard's role-based HR branch: an HR caller
        // browsing the ordinary views reads content only via the audited view=user.
        val unfinished = row[Feedbacks.status] == FeedbackStatus.DRAFT ||
            row[Feedbacks.status] == FeedbackStatus.REQUESTED
        val redactContent = view != FeedbackListView.USER &&
            row[Feedbacks.providerId].value != callerUserId &&
            unfinished && row[Feedbacks.requesterId]?.value == callerUserId
        val decrypted = if (redactContent) "" else cipher.decrypt(row[Feedbacks.content])
        return FeedbackListItem(
            id = row[Feedbacks.id].value,
            requesterId = row[Feedbacks.requesterId]?.value,
            requesterName = row.getOrNull(requesterUsers[UserService.Users.name]),
            requesterDeleted = row.getOrNull(requesterUsers[UserService.Users.markedAsDeleted]) ?: false,
            subjectId = row[Feedbacks.subjectId].value,
            subjectName = row[subjectUsers[UserService.Users.name]],
            subjectDeleted = row[subjectUsers[UserService.Users.markedAsDeleted]],
            providerId = row[Feedbacks.providerId].value,
            providerName = row[providerUsers[UserService.Users.name]],
            providerDeleted = row[providerUsers[UserService.Users.markedAsDeleted]],
            visibility = row[Feedbacks.visibility],
            status = row[Feedbacks.status],
            expiresOn = row[Feedbacks.expiresOn],
            contentPreview = decrypted.take(CONTENT_PREVIEW_LENGTH),
            // The Kudos wall renders full content inline (expand-on-click), and every
            // kudos row is PUBLIC+SENT — never redacted — so only that view carries it.
            content = if (view == FeedbackListView.KUDOS) decrypted else null,
            lastModified = row[Feedbacks.lastModified],
        )
    }

    /**
     * True iff [managerId] is in the management chain of ANY of [subjectIds] — the manager of a
     * non-deleted team a recipient belongs to, or, transitively, the manager of such a manager,
     * and so on. Mirrors the widest ([FeedbackListView.TEAM] with includeIndirect=true) list
     * scope so a manager who can list a subordinate's feedback can also read the individual
     * record (the list's direct-only default is a narrower slice of the same right, not a
     * separate authorization). The walk itself lives in teams/ManagementChain.kt
     * ([isInManagementChain]) and is shared with the 1:1 meetings feature.
     */
    suspend fun managesAnySubject(managerId: UInt, subjectIds: Collection<UInt>): Boolean =
        suspendTransaction(database) { isInManagementChain(managerId, subjectIds.toSet()) }

    private fun buildPredicate(filter: FeedbackListFilter): Op<Boolean> {
        var op: Op<Boolean> = Op.TRUE
        filter.requesterName?.takeIf { it.isNotBlank() }?.let {
            op = op and (requesterUsers[UserService.Users.name].containsNormalized(it))
        }
        // Any recipient's name: the anchor alias OR the join table's users (the unaliased Users
        // inside the subquery does not clash with the three outer aliases).
        filter.subjectName?.takeIf { it.isNotBlank() }?.let { needle ->
            val matching = FeedbackSubjects
                .join(
                    UserService.Users,
                    JoinType.INNER,
                    onColumn = FeedbackSubjects.userId,
                    otherColumn = UserService.Users.id,
                )
                .select(FeedbackSubjects.feedbackId)
                .where { UserService.Users.name.containsNormalized(needle) }
            op = op and (
                subjectUsers[UserService.Users.name].containsNormalized(needle) or
                    (Feedbacks.id inSubQuery matching)
                )
        }
        filter.providerName?.takeIf { it.isNotBlank() }?.let {
            op = op and (providerUsers[UserService.Users.name].containsNormalized(it))
        }
        filter.providerId?.let { op = op and (Feedbacks.providerId eq it) }
        filter.subjectId?.let { op = op and isSubject(it) }
        filter.visibility?.let { op = op and (Feedbacks.visibility eq it) }
        filter.status?.let { op = op and (Feedbacks.status eq it) }
        filter.lastModifiedGte?.let { op = op and (Feedbacks.lastModified greaterEq it) }
        return op
    }

    /**
     * The visibility ↔ requester coherence rules, shared by creation ([validate]) and
     * [editContent] (the only mutation that can change visibility). Status transitions are NOT
     * checked here — they are [transition]'s rule (a 409, not a 400).
     */
    private fun requireCoherentVisibility(requesterId: UInt?, visibility: FeedbackVisibility) {
        if (requesterId != null && visibility == FeedbackVisibility.PROVIDER_SUBJECT) {
            throw BadRequestException("A feedback with a requester must not use PROVIDER_SUBJECT visibility")
        }
        // The mirror image: PROVIDER_REQUESTER visibility excludes the subject, so without a
        // requester nobody but the provider could ever read it — and the subject's Received
        // list would leak its preview (no-requester rows skip the visibility filter there).
        if (requesterId == null && visibility == FeedbackVisibility.PROVIDER_REQUESTER) {
            throw BadRequestException("PROVIDER_REQUESTER visibility requires a requester")
        }
    }

    private fun validate(next: Feedback) {
        // provider ∈ subjects (a legacy SELF-REFLECTION row) is deliberately NOT rejected here:
        // the ROUTE blocks NEW ones since v2.36.0; this validator runs on create only (never on
        // editContent), so legacy rows stay serviceable either way. requester ≠ provider (below)
        // prevents requesting feedback from yourself.
        if (next.requesterId != null && next.requesterId == next.providerId) {
            throw BadRequestException("Requester cannot also be the provider")
        }
        validateFeedbackTexts(next.content, next.requesterMessage)
        validateSubjects(next)
        requireCoherentVisibility(next.requesterId, next.visibility)
        if (next.status == FeedbackStatus.REQUESTED && next.requesterId == null) {
            throw BadRequestException("Requested status requires a requester")
        }
    }

    private fun isAllowedTransition(from: FeedbackStatus, to: FeedbackStatus): Boolean = when (from to to) {
        FeedbackStatus.REQUESTED to FeedbackStatus.DRAFT,
        FeedbackStatus.REQUESTED to FeedbackStatus.REJECTED,
        FeedbackStatus.DRAFT to FeedbackStatus.SENT,
        FeedbackStatus.DRAFT to FeedbackStatus.WITHDRAWN,
        FeedbackStatus.SENT to FeedbackStatus.WITHDRAWN -> true
        else -> false
    }
}
