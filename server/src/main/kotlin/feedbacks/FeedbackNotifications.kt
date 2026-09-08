package ch.nokillswit.feedbacks

import ch.nokillswit.notifications.Notification
import ch.nokillswit.notifications.NotificationType

/**
 * Pure mapping from a feedback status transition to the notifications it should produce.
 * Kept side-effect-free (no DB) so it can be unit-tested directly; [FeedbackService.update]
 * resolves the party names and the persistence happens in the route.
 *
 * @param next the feedback after the update (its ids/visibility are the source of truth).
 * @param nameById display names for the parties (provider/subject/requester).
 * @param subjectManagerNames id → name of the recipients' direct managers; they gain read access
 *   when the feedback is delivered, so a SENT landing notifies them too. Pass empty (the
 *   default) on transitions that cannot land in SENT — no query needed.
 * @param recipientsByManager manager id → the recipient ids THAT manager directly manages
 *   (v3.1.1): a manager's note names only their own people — the "who reports to you" wording
 *   must not claim the other recipients. A manager absent from the map falls back to the full
 *   recipient list (the single-recipient callers need not pass it).
 */
internal fun feedbackTransitionNotifications(
    feedbackId: UInt,
    from: FeedbackStatus,
    next: Feedback,
    nameById: Map<UInt, String>,
    subjectManagerNames: Map<UInt, String> = emptyMap(),
    recipientsByManager: Map<UInt, Set<UInt>> = emptyMap(),
): List<Notification> {
    // provider == subject is a LEGACY SELF-REFLECTION row (new ones are rejected at create
    // since v2.36.0, but stored rows still transition). Its transitions are performed by that
    // very person, so the subject/provider-directed notifications below would tell the acting
    // user about their own action — they are filtered out at the end. Requester-directed ones
    // (a requested self-reflection) survive, worded via the `self` i18next context.
    val isSelfReflection = next.providerId in next.subjectIds
    val selfParams = if (isSelfReflection) mapOf("self" to "self") else emptyMap()

    val to = next.status
    val provider = nameById.nameOf(next.providerId)
    val subject = next.subjectLabel(nameById)
    val requester = next.requesterId?.let { nameById.nameOf(it) }

    val notifications = mutableListOf<Notification>()

    when {
        from == FeedbackStatus.DRAFT && to == FeedbackStatus.SENT -> {
            notifications += sentToSubjectNotes(feedbackId, next, nameById)
            notifications += sentToProviderNote(feedbackId, next, nameById)
            notifications += sentToManagerNotes(
                feedbackId, next, nameById, subjectManagerNames, recipientsByManager, selfParams,
            )
        }

        from == FeedbackStatus.REQUESTED && to == FeedbackStatus.REJECTED && next.requesterId != null ->
            notifications += Notification(
                recipientId = next.requesterId,
                type = NotificationType.FEEDBACK_REJECTED_TO_REQUESTER,
                params = mapOf("requester" to requester!!, "provider" to provider, "subject" to subject) + selfParams,
            )

        from == FeedbackStatus.REQUESTED && to == FeedbackStatus.DRAFT && next.requesterId != null ->
            notifications += Notification(
                recipientId = next.requesterId,
                type = NotificationType.FEEDBACK_PICKED_UP_TO_REQUESTER,
                params = mapOf("requester" to requester!!, "provider" to provider, "subject" to subject) + selfParams,
            )

        // Retracting a SENT feedback and abandoning a DRAFT both land in WITHDRAWN — a
        // delivered status, so the record becomes visible in the subject's Received list
        // either way; both paths notify identically (an abandoned draft must not appear
        // there silently).
        (from == FeedbackStatus.SENT || from == FeedbackStatus.DRAFT) && to == FeedbackStatus.WITHDRAWN -> {
            // One note per recipient, each carrying their own name (the sentToSubjectNotes rule).
            next.subjectIds.forEach { subjectId ->
                notifications += Notification(
                    recipientId = subjectId,
                    type = NotificationType.FEEDBACK_WITHDRAWN_TO_SUBJECT,
                    params = mapOf("provider" to provider, "subject" to nameById.nameOf(subjectId)),
                )
            }
            if (next.requesterId != null) {
                notifications += Notification(
                    recipientId = next.requesterId,
                    type = NotificationType.FEEDBACK_WITHDRAWN_TO_REQUESTER,
                    params = mapOf("provider" to provider, "subject" to subject, "requester" to requester!!) + selfParams,
                )
            }
        }
    }

    // A "sent" of requested feedback also notifies the requester (in addition to the subject
    // notification above for DRAFT -> SENT). REQUESTED -> SENT is not an allowed transition, so
    // in practice this fires alongside the DRAFT -> SENT case.
    if (to == FeedbackStatus.SENT && (from == FeedbackStatus.DRAFT || from == FeedbackStatus.REQUESTED)) {
        sentToRequesterNote(feedbackId, next, nameById, selfParams)?.let { notifications += it }
    }

    // Self-reflection: drop the notifications aimed at the subject/provider — that IS the acting
    // user (requester ≠ provider guarantees the requester-directed ones are unaffected).
    return if (isSelfReflection) notifications.filter { it.recipientId != next.providerId } else notifications
}

/**
 * Notifications produced when a feedback is *created* (as opposed to transitioned). Two cases:
 * a brand-new feedback in [FeedbackStatus.REQUESTED] status (the designated provider is told
 * that feedback has been requested of them, the requester gets a confirmation), and a feedback
 * created directly as [FeedbackStatus.SENT] ("save & send" — same recipient set as the
 * DRAFT -> SENT transition, so who gets notified never depends on whether a draft step
 * happened). Any other status (a private DRAFT) produces nothing. Pure / side-effect-free like
 * [feedbackTransitionNotifications]; [FeedbackService.create] resolves names and persists.
 *
 * @param feedbackId the id assigned by the insert (drives the edit/view links).
 * @param created the feedback as persisted.
 * @param nameById display names for the parties (requester/subject).
 * @param subjectManagerNames id → name of the recipients' direct managers (SENT creations only —
 *   see [feedbackTransitionNotifications]).
 * @param recipientsByManager manager id → the recipient ids they manage (see
 *   [feedbackTransitionNotifications]).
 */
internal fun feedbackCreationNotifications(
    feedbackId: UInt,
    created: Feedback,
    nameById: Map<UInt, String>,
    subjectManagerNames: Map<UInt, String> = emptyMap(),
    recipientsByManager: Map<UInt, Set<UInt>> = emptyMap(),
): List<Notification> {
    if (created.status == FeedbackStatus.SENT) {
        // Mirror the DRAFT -> SENT transition exactly, including the self-reflection rule:
        // a standalone self row ("save & send" about yourself) notifies no party (the acting
        // user is every recipient) — though the subject's managers, who are not the actor,
        // are still told; a requested one notifies only the requester, self-worded.
        val isSelfReflection = created.providerId in created.subjectIds
        val selfParams = if (isSelfReflection) mapOf("self" to "self") else emptyMap()
        val notifications = sentToSubjectNotes(feedbackId, created, nameById) + listOfNotNull(
            sentToProviderNote(feedbackId, created, nameById),
            sentToRequesterNote(feedbackId, created, nameById, selfParams),
        ) + sentToManagerNotes(feedbackId, created, nameById, subjectManagerNames, recipientsByManager, selfParams)
        return if (isSelfReflection) {
            notifications.filter { it.recipientId != created.providerId }
        } else {
            notifications
        }
    }
    if (created.status != FeedbackStatus.REQUESTED) return emptyList()
    // REQUESTED requires a requester (enforced in FeedbackService.validate), so this is non-null.
    val requesterId = created.requesterId ?: return emptyList()
    val requester = nameById.nameOf(requesterId)
    val provider = nameById.nameOf(created.providerId)
    // A REQUESTED feedback has exactly one recipient (validateSubjects), so this is one name.
    val subject = created.subjectLabel(nameById)

    // The requester is confirmed their request went out; no link (nothing to open yet). The wording
    // differs when they asked for feedback about themselves (subject == requester, `self` context)
    // or asked the subject for a self-reflection (subject == provider, `reflection` context) —
    // the `self` param's VALUE drives the i18next context suffix in the SPA.
    val requesterNote = when {
        requesterId in created.subjectIds ->
            Notification(
                recipientId = requesterId,
                type = NotificationType.FEEDBACK_REQUESTED_TO_REQUESTER,
                params = mapOf("provider" to provider, "self" to "self"),
            )
        created.providerId in created.subjectIds ->
            Notification(
                recipientId = requesterId,
                type = NotificationType.FEEDBACK_REQUESTED_TO_REQUESTER,
                params = mapOf("provider" to provider, "subject" to subject, "self" to "reflection"),
            )
        else ->
            Notification(
                recipientId = requesterId,
                type = NotificationType.FEEDBACK_REQUESTED_TO_REQUESTER,
                params = mapOf("provider" to provider, "subject" to subject),
            )
    }

    // The provider is asked to write; when they ARE the subject (a requested self-reflection),
    // the `self` context words it as "asked you for a self-reflection".
    val providerSelf =
        if (created.providerId in created.subjectIds) mapOf("self" to "self") else emptyMap()

    return listOf(
        Notification(
            recipientId = created.providerId,
            type = NotificationType.FEEDBACK_REQUESTED_TO_PROVIDER,
            params = mapOf("requester" to requester, "subject" to subject) + providerSelf,
            link = "/feedback/$feedbackId/edit",
        ),
        requesterNote,
    )
}

/**
 * Notification produced when a feedback is *deleted* (soft-deleted) by its provider. When the
 * feedback has a requester, they are told the provider deleted it; the notification carries **no
 * link** (there is nothing left to open). Returns empty when there is no requester. Pure /
 * side-effect-free like the others; the route resolves names and persists.
 *
 * @param deleted the feedback as it was before deletion (source of the ids).
 * @param nameById display names for the parties (provider/subject).
 */
internal fun feedbackDeletionNotifications(
    deleted: Feedback,
    nameById: Map<UInt, String>,
): List<Notification> {
    val requesterId = deleted.requesterId ?: return emptyList()
    val provider = nameById.nameOf(deleted.providerId)
    val subject = deleted.subjectLabel(nameById)
    // A deleted requested self-reflection is worded via the `self` context, like the transitions.
    val selfParams =
        if (deleted.providerId in deleted.subjectIds) mapOf("self" to "self") else emptyMap()
    return listOf(
        Notification(
            recipientId = requesterId,
            type = NotificationType.FEEDBACK_DELETED_TO_REQUESTER,
            params = mapOf("provider" to provider, "subject" to subject) + selfParams,
        ),
    )
}

// Params shared by both v3.8.0 expiry notifications — the FEEDBACK_REJECTED_TO_REQUESTER shape.
// A REQUESTED feedback is always single-recipient and always carries a requester
// (validateSubjects / FeedbackService.validate), so both are safe to resolve here.
private fun Feedback.expiryParams(nameById: Map<UInt, String>): Map<String, String> = mapOf(
    "requester" to (requesterId?.let { nameById.nameOf(it) } ?: "?"),
    "provider" to nameById.nameOf(providerId),
    "subject" to subjectLabel(nameById),
)

/**
 * Notification telling the REQUESTER their feedback request expired unanswered — minted by the
 * lazy sweep (v3.8.0, `FeedbackService.expireOverdueRequests`). A REQUESTED feedback always
 * carries a requester (`FeedbackService.validate`), so [Feedback.requesterId] is required.
 */
internal fun feedbackExpiredToRequesterNotification(
    feedback: Feedback,
    nameById: Map<UInt, String>,
): Notification {
    val requesterId = requireNotNull(feedback.requesterId) {
        "expireOverdueRequests only sweeps REQUESTED rows, which always carry a requester"
    }
    return Notification(
        recipientId = requesterId,
        type = NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER,
        params = feedback.expiryParams(nameById),
    )
}

/** The provider's mirror of [feedbackExpiredToRequesterNotification]. */
internal fun feedbackExpiredToProviderNotification(
    feedback: Feedback,
    nameById: Map<UInt, String>,
): Notification = Notification(
    recipientId = feedback.providerId,
    type = NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER,
    params = feedback.expiryParams(nameById),
)

// The `subject` param rule for a multi-recipient feedback (v3.1.0): a note addressed TO a
// recipient carries that recipient's own name; a MANAGER's note names only the recipients who
// report to them (v3.1.1 — the template says "who reports to you"); every other note carries
// all recipients' names joined in position order — identical to today's value for one
// recipient, so the i18n templates and email texts interpolate unchanged. Only the provider
// and manager notes can ever see several names: every requester-related note rides a
// requested feedback, which is single-recipient by rule.
private fun Feedback.subjectLabel(nameById: Map<UInt, String>, only: Set<UInt>? = null): String =
    subjectIds.filter { only == null || it in only }.joinToString(", ") { nameById.nameOf(it) }

// The notes minted whenever a feedback lands in SENT — shared by the DRAFT -> SENT transition
// and a feedback created directly as SENT ("save & send"), so the two paths can never drift.

/** One note per recipient, each naming the recipient themselves. */
private fun sentToSubjectNotes(
    feedbackId: UInt,
    feedback: Feedback,
    nameById: Map<UInt, String>,
): List<Notification> = feedback.subjectIds.map { subjectId ->
    Notification(
        recipientId = subjectId,
        type = NotificationType.FEEDBACK_SENT_TO_SUBJECT,
        params = mapOf(
            "provider" to nameById.nameOf(feedback.providerId),
            "subject" to nameById.nameOf(subjectId),
        ),
        link = "/feedback/$feedbackId/view".takeIf { subjectCanRead(feedback.visibility) },
    )
}

// The provider (sender) is confirmed their feedback went out; they can always read their own
// feedback, so the view link is unconditional.
private fun sentToProviderNote(
    feedbackId: UInt,
    feedback: Feedback,
    nameById: Map<UInt, String>,
): Notification = Notification(
    recipientId = feedback.providerId,
    type = NotificationType.FEEDBACK_SENT_TO_PROVIDER,
    params = mapOf("subject" to feedback.subjectLabel(nameById)),
    link = "/feedback/$feedbackId/view",
)

/**
 * One note per direct manager of any recipient — they gain read access when the feedback is
 * delivered, and that read is not visibility-gated, so the view link is unconditional. Managers
 * who are themselves a party (provider/recipient/requester) are excluded: they are the actor or
 * already notified in that role. Self-reflections keep these notes (the manager is never the
 * acting user), worded via the `self` context.
 */
private fun sentToManagerNotes(
    feedbackId: UInt,
    feedback: Feedback,
    nameById: Map<UInt, String>,
    managerNames: Map<UInt, String>,
    recipientsByManager: Map<UInt, Set<UInt>>,
    selfParams: Map<String, String>,
): List<Notification> {
    val parties = setOfNotNull(feedback.providerId, feedback.requesterId) + feedback.subjectIds
    return managerNames.keys.filter { it !in parties }.map { managerId ->
        // Only the recipients who report to THIS manager (an unmapped manager — the
        // single-recipient callers — gets the whole list, which is that one recipient).
        val own = recipientsByManager[managerId]?.takeIf { it.isNotEmpty() }
        Notification(
            recipientId = managerId,
            type = NotificationType.FEEDBACK_SENT_TO_MANAGER,
            params = mapOf(
                "provider" to nameById.nameOf(feedback.providerId),
                "subject" to feedback.subjectLabel(nameById, only = own),
            ) + selfParams,
            link = "/feedback/$feedbackId/view",
        )
    }
}

/** Null when the feedback has no requester. */
private fun sentToRequesterNote(
    feedbackId: UInt,
    feedback: Feedback,
    nameById: Map<UInt, String>,
    selfParams: Map<String, String>,
): Notification? = feedback.requesterId?.let { requesterId ->
    Notification(
        recipientId = requesterId,
        type = NotificationType.FEEDBACK_SENT_TO_REQUESTER,
        params = mapOf(
            "provider" to nameById.nameOf(feedback.providerId),
            "subject" to feedback.subjectLabel(nameById),
            "requester" to nameById.nameOf(requesterId),
        ) + selfParams,
        link = "/feedback/$feedbackId/view".takeIf { requesterCanRead(feedback.visibility) },
    )
}

private fun Map<UInt, String>.nameOf(id: UInt): String = this[id] ?: "#$id"

private fun subjectCanRead(visibility: FeedbackVisibility): Boolean = when (visibility) {
    FeedbackVisibility.PUBLIC,
    FeedbackVisibility.PROVIDER_SUBJECT,
    FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT -> true
    FeedbackVisibility.PROVIDER_REQUESTER -> false
}

private fun requesterCanRead(visibility: FeedbackVisibility): Boolean = when (visibility) {
    FeedbackVisibility.PUBLIC,
    FeedbackVisibility.PROVIDER_REQUESTER,
    FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT -> true
    FeedbackVisibility.PROVIDER_SUBJECT -> false
}
