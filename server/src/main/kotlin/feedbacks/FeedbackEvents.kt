package ch.nokillswit.feedbacks

import kotlinx.serialization.Serializable

/**
 * Pure mapping from a feedback create / update / delete to the structured audit event it should
 * record. Side-effect-free (no DB) so it can be unit-tested directly; the acting user is the caller
 * and persistence happens in the route (see FeedbackRoutes).
 *
 * Events are stored structurally ([FeedbackEventType] + [FeedbackEventDescriptor.params]) so the SPA
 * renders each one in the viewer's language.
 */

@Serializable
enum class FeedbackEventType {
    CREATED,
    DELETED,
    STATUS_CHANGED,
    CONTENT_UPDATED,
    CONTENT_AND_VISIBILITY_UPDATED,
    VISIBILITY_CHANGED,
    // The lazy expiry sweep auto-rejecting an overdue REQUESTED row (v3.8.0) — see
    // feedbackExpiryEvent() and FeedbackService.expireOverdueRequests.
    REQUEST_EXPIRED,
}

/** A structured audit event: its [type] plus string params (enum names) for interpolation. */
data class FeedbackEventDescriptor(
    val type: FeedbackEventType,
    val params: Map<String, String> = emptyMap(),
)

/** Structured event recorded when a feedback is first created, keyed on its initial status. */
internal fun feedbackCreationEvent(created: Feedback): FeedbackEventDescriptor =
    FeedbackEventDescriptor(FeedbackEventType.CREATED, mapOf("status" to created.status.name))

/** Structured event recorded when a draft feedback is deleted (soft-deleted) by its provider. */
internal fun feedbackDeletionEvent(): FeedbackEventDescriptor =
    FeedbackEventDescriptor(FeedbackEventType.DELETED)

/**
 * Structured event recorded when a REQUESTED feedback auto-rejects past its `expiresOn`
 * deadline (the lazy sweep, v3.8.0 — `FeedbackService.expireOverdueRequests`). Side-effect-free
 * and empty-params like [feedbackDeletionEvent] — the rendered sentence carries no actor, so the
 * event is attributed to the PROVIDER purely because `feedback_events.user_id` is `NOT NULL`
 * (there is no cheap system-user id); the resolved `userName` on that row is immaterial.
 */
internal fun feedbackExpiryEvent(): FeedbackEventDescriptor =
    FeedbackEventDescriptor(FeedbackEventType.REQUEST_EXPIRED)

/**
 * Structured event recorded on update. A status change wins; otherwise it reports the
 * content/visibility edit. Returns null when nothing audit-worthy changed (so no empty event).
 */
internal fun feedbackUpdateEvent(before: Feedback, after: Feedback): FeedbackEventDescriptor? {
    if (before.status != after.status) {
        return FeedbackEventDescriptor(
            FeedbackEventType.STATUS_CHANGED,
            mapOf("from" to before.status.name, "to" to after.status.name),
        )
    }
    val contentChanged = before.content != after.content
    val visibilityChanged = before.visibility != after.visibility
    return when {
        contentChanged && visibilityChanged ->
            FeedbackEventDescriptor(FeedbackEventType.CONTENT_AND_VISIBILITY_UPDATED)
        contentChanged -> FeedbackEventDescriptor(FeedbackEventType.CONTENT_UPDATED)
        visibilityChanged -> FeedbackEventDescriptor(
            FeedbackEventType.VISIBILITY_CHANGED,
            mapOf("to" to after.visibility.name),
        )
        else -> null
    }
}
