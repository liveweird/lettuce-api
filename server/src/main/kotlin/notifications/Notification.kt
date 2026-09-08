package ch.nokillswit.notifications

import ch.nokillswit.infra.paging.PageResponse
import ch.nokillswit.users.Feature
import kotlinx.serialization.Serializable

/**
 * The kind of notification, driving both the recipient's wording and its params. Values are
 * produced by feedbacks/FeedbackNotifications.kt, oneonones/OneOnOneNotifications.kt,
 * goals/GoalNotifications.kt, teamkpis/TeamKpiNotifications.kt,
 * reviews/PerformanceReviewNotifications.kt, daysoff/DaysOffNotifications.kt,
 * pulse/PulseNotifications.kt, impactlog/ImpactLogNotifications.kt,
 * and the password-change paths (users/UserRoutes.kt,
 * auth/AuthRoutes.kt); the SPA renders each one in the viewer's language from
 * `notifications.event.*` keys.
 */
@Serializable
enum class NotificationType {
    FEEDBACK_REQUESTED_TO_PROVIDER,
    FEEDBACK_REQUESTED_TO_REQUESTER,
    FEEDBACK_SENT_TO_SUBJECT,
    FEEDBACK_SENT_TO_PROVIDER,
    FEEDBACK_SENT_TO_REQUESTER,
    FEEDBACK_SENT_TO_MANAGER,
    FEEDBACK_REJECTED_TO_REQUESTER,
    FEEDBACK_PICKED_UP_TO_REQUESTER,
    FEEDBACK_WITHDRAWN_TO_SUBJECT,
    FEEDBACK_WITHDRAWN_TO_REQUESTER,
    FEEDBACK_DELETED_TO_REQUESTER,
    // The lazy expiry sweep (v3.8.0 — FeedbackService.expireOverdueRequests) auto-rejecting an
    // overdue REQUESTED row; both parties are told.
    FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER,
    FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER,
    ONE_ON_ONE_CREATED_TO_SUBORDINATE,
    ONE_ON_ONE_CREATED_TO_MANAGER,
    GOAL_ACTIVATED_TO_SUBORDINATE,
    GOAL_DEACTIVATED_TO_SUBORDINATE,
    GOAL_ARCHIVED_TO_SUBORDINATE,
    GOAL_REOPENED_TO_SUBORDINATE,
    GOAL_PROGRESS_UPDATED_TO_SUBORDINATE,
    GOAL_PROGRESS_UPDATED_TO_MANAGER,
    TEAM_KPI_ACTIVATED_TO_MEMBER,
    TEAM_KPI_DEACTIVATED_TO_MEMBER,
    TEAM_KPI_ARCHIVED_TO_MEMBER,
    TEAM_KPI_REOPENED_TO_MEMBER,
    TEAM_KPI_VALUE_RECORDED_TO_MEMBER,
    TEAM_KPI_VALUE_CORRECTED_TO_MEMBER,
    TEAM_KPI_VALUE_REMOVED_TO_MEMBER,
    PERFORMANCE_REVIEW_PUBLISHED_TO_SUBORDINATE,
    PERFORMANCE_REVIEW_UNPUBLISHED_TO_SUBORDINATE,
    DAYS_OFF_REQUESTED_TO_MANAGER,
    DAYS_OFF_ACCEPTED_TO_OWNER,
    DAYS_OFF_REJECTED_TO_OWNER,
    DAYS_OFF_CANCELLED_TO_MANAGER,
    DAYS_OFF_CANCELLED_TO_OWNER,
    DAYS_OFF_CORRECTED_TO_OWNER,
    DAYS_OFF_RECORDED_TO_OWNER,
    DAYS_OFF_RECORDED_TO_MANAGER,
    DAYS_OFF_ALLOWANCE_CHANGED,
    PULSE_CYCLE_SCHEDULED,
    PULSE_CYCLE_OPENED,
    PULSE_RESULTS_AVAILABLE,
    PULSE_CYCLE_CANCELLED,
    IMPACT_ENTRY_CREATED_TO_MANAGER,
    IMPACT_ENTRY_UPDATED_TO_MANAGER,
    IMPACT_ENTRY_DELETED_TO_MANAGER,
    CAREER_POSITION_STARTED_TO_USER,
    PASSWORD_CHANGED,
}

/**
 * The feature each notification type belongs to — null (PASSWORD_CHANGED) = feature-neutral,
 * never filtered. Backs the per-user feature-flag exclusion in the recipient's list/total
 * (V46): rows whose type maps to a disabled feature are hidden (and uncounted) while the flag
 * is off, and reappear on re-enable — minting is never suppressed. The exhaustive `when`
 * forces every future type to pick a side.
 */
val NotificationType.feature: Feature?
    get() = when (this) {
        NotificationType.FEEDBACK_REQUESTED_TO_PROVIDER,
        NotificationType.FEEDBACK_REQUESTED_TO_REQUESTER,
        NotificationType.FEEDBACK_SENT_TO_SUBJECT,
        NotificationType.FEEDBACK_SENT_TO_PROVIDER,
        NotificationType.FEEDBACK_SENT_TO_REQUESTER,
        NotificationType.FEEDBACK_SENT_TO_MANAGER,
        NotificationType.FEEDBACK_REJECTED_TO_REQUESTER,
        NotificationType.FEEDBACK_PICKED_UP_TO_REQUESTER,
        NotificationType.FEEDBACK_WITHDRAWN_TO_SUBJECT,
        NotificationType.FEEDBACK_WITHDRAWN_TO_REQUESTER,
        NotificationType.FEEDBACK_DELETED_TO_REQUESTER,
        NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER,
        NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER,
        -> Feature.FEEDBACKS
        NotificationType.ONE_ON_ONE_CREATED_TO_SUBORDINATE,
        NotificationType.ONE_ON_ONE_CREATED_TO_MANAGER,
        -> Feature.ONE_ON_ONES
        NotificationType.GOAL_ACTIVATED_TO_SUBORDINATE,
        NotificationType.GOAL_DEACTIVATED_TO_SUBORDINATE,
        NotificationType.GOAL_ARCHIVED_TO_SUBORDINATE,
        NotificationType.GOAL_REOPENED_TO_SUBORDINATE,
        NotificationType.GOAL_PROGRESS_UPDATED_TO_SUBORDINATE,
        NotificationType.GOAL_PROGRESS_UPDATED_TO_MANAGER,
        -> Feature.GOALS
        NotificationType.TEAM_KPI_ACTIVATED_TO_MEMBER,
        NotificationType.TEAM_KPI_DEACTIVATED_TO_MEMBER,
        NotificationType.TEAM_KPI_ARCHIVED_TO_MEMBER,
        NotificationType.TEAM_KPI_REOPENED_TO_MEMBER,
        NotificationType.TEAM_KPI_VALUE_RECORDED_TO_MEMBER,
        NotificationType.TEAM_KPI_VALUE_CORRECTED_TO_MEMBER,
        NotificationType.TEAM_KPI_VALUE_REMOVED_TO_MEMBER,
        -> Feature.TEAM_KPIS
        NotificationType.PERFORMANCE_REVIEW_PUBLISHED_TO_SUBORDINATE,
        NotificationType.PERFORMANCE_REVIEW_UNPUBLISHED_TO_SUBORDINATE,
        -> Feature.PERFORMANCE_REVIEWS
        NotificationType.DAYS_OFF_REQUESTED_TO_MANAGER,
        NotificationType.DAYS_OFF_ACCEPTED_TO_OWNER,
        NotificationType.DAYS_OFF_REJECTED_TO_OWNER,
        NotificationType.DAYS_OFF_CANCELLED_TO_MANAGER,
        NotificationType.DAYS_OFF_CANCELLED_TO_OWNER,
        NotificationType.DAYS_OFF_CORRECTED_TO_OWNER,
        NotificationType.DAYS_OFF_RECORDED_TO_OWNER,
        NotificationType.DAYS_OFF_RECORDED_TO_MANAGER,
        NotificationType.DAYS_OFF_ALLOWANCE_CHANGED,
        -> Feature.DAYS_OFF
        NotificationType.PULSE_CYCLE_SCHEDULED,
        NotificationType.PULSE_CYCLE_OPENED,
        NotificationType.PULSE_RESULTS_AVAILABLE,
        NotificationType.PULSE_CYCLE_CANCELLED,
        -> Feature.PULSE_SURVEYS
        NotificationType.IMPACT_ENTRY_CREATED_TO_MANAGER,
        NotificationType.IMPACT_ENTRY_UPDATED_TO_MANAGER,
        NotificationType.IMPACT_ENTRY_DELETED_TO_MANAGER,
        -> Feature.IMPACT_LOG
        // Career positions ride the ungated users area (v2.15.0) — feature-neutral like the
        // password notice, never filtered by a flag.
        NotificationType.CAREER_POSITION_STARTED_TO_USER,
        NotificationType.PASSWORD_CHANGED,
        -> null
    }

/**
 * Internal create input. There is no public create endpoint: notifications are generated as a
 * side-effect of other activities and minted via [NotificationService.create]. [params] carries the
 * interpolation values (party names as proper nouns) the localized message needs.
 */
@Serializable
data class Notification(
    val recipientId: UInt,
    val type: NotificationType,
    val params: Map<String, String> = emptyMap(),
    val link: String? = null,
)

@Serializable
data class NotificationResponse(
    val id: UInt,
    val recipientId: UInt,
    // Epoch milliseconds; when the notification was generated. Server-managed.
    val timestamp: Long,
    val type: NotificationType,
    val params: Map<String, String> = emptyMap(),
    val link: String?,
    val wasSeen: Boolean,
)

typealias NotificationPageResponse = PageResponse<NotificationResponse>
