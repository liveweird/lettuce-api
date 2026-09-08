package ch.nokillswit

import ch.nokillswit.feedbacks.Feedback
import ch.nokillswit.feedbacks.FeedbackStatus
import ch.nokillswit.feedbacks.FeedbackVisibility
import ch.nokillswit.feedbacks.feedbackCreationNotifications
import ch.nokillswit.feedbacks.feedbackDeletionNotifications
import ch.nokillswit.feedbacks.feedbackExpiredToProviderNotification
import ch.nokillswit.feedbacks.feedbackExpiredToRequesterNotification
import ch.nokillswit.feedbacks.feedbackTransitionNotifications
import ch.nokillswit.notifications.NotificationType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Pure unit tests for the transition → notification mapping (no DB / container). */
class FeedbackNotificationsTest {

    private val names = mapOf(1u to "Provider Pat", 2u to "Subject Sam", 3u to "Requester Rita")
    private val pat = "Provider Pat"
    private val sam = "Subject Sam"
    private val rita = "Requester Rita"

    private fun feedback(
        status: FeedbackStatus,
        // Default carries a requester, so the default visibility must be requester-inclusive
        // (a requester + PROVIDER_SUBJECT is an illegal combination per the server invariant).
        visibility: FeedbackVisibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
        requesterId: UInt? = 3u,
    ) = Feedback(
        requesterId = requesterId,
        subjectId = 2u,
        providerId = 1u,
        visibility = visibility,
        status = status,
    )

    @Test
    fun `draft to sent notifies subject, provider and requester, naming the parties`() {
        val next = feedback(FeedbackStatus.SENT, FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT)
        val result = feedbackTransitionNotifications(42u, FeedbackStatus.DRAFT, next, names)

        assertEquals(3, result.size)
        val toSubject = result.single { it.recipientId == 2u }
        val toProvider = result.single { it.recipientId == 1u }
        val toRequester = result.single { it.recipientId == 3u }

        assertEquals(NotificationType.FEEDBACK_SENT_TO_SUBJECT, toSubject.type)
        assertEquals(pat, toSubject.params["provider"])
        assertEquals(sam, toSubject.params["subject"])
        // PROVIDER_REQUESTER_SUBJECT is readable by both → both get links.
        assertEquals("/feedback/42/view", toSubject.link)

        // The provider (sender) gets a confirmation with an unconditional view link.
        assertEquals(NotificationType.FEEDBACK_SENT_TO_PROVIDER, toProvider.type)
        assertEquals(sam, toProvider.params["subject"])
        assertEquals("/feedback/42/view", toProvider.link)

        assertEquals(NotificationType.FEEDBACK_SENT_TO_REQUESTER, toRequester.type)
        assertEquals(rita, toRequester.params["requester"])
        assertEquals(pat, toRequester.params["provider"])
        assertEquals(sam, toRequester.params["subject"])
        assertEquals("/feedback/42/view", toRequester.link)
    }

    // ── Multi-recipient feedback (v3.1.0) ─────────────────────────────────────

    private val multiNames = names + (4u to "Subject Sue") + (9u to "Mia Manager") + (8u to "Max Manager")

    private fun multi(status: FeedbackStatus) = Feedback(
        requesterId = null,
        subjectId = 2u,
        additionalSubjectIds = listOf(4u),
        providerId = 1u,
        visibility = FeedbackVisibility.PROVIDER_SUBJECT,
        status = status,
    )

    @Test
    fun `sending a multi-recipient feedback notes each recipient by their own name and joins the rest`() {
        val managers = mapOf(9u to "Mia Manager", 8u to "Max Manager", 4u to "Subject Sue")
        val result = feedbackTransitionNotifications(42u, FeedbackStatus.DRAFT, multi(FeedbackStatus.SENT), multiNames, managers)

        val toSam = result.single { it.recipientId == 2u && it.type == NotificationType.FEEDBACK_SENT_TO_SUBJECT }
        val toSue = result.single { it.recipientId == 4u && it.type == NotificationType.FEEDBACK_SENT_TO_SUBJECT }
        assertEquals(sam, toSam.params["subject"])
        assertEquals("Subject Sue", toSue.params["subject"])
        assertEquals("/feedback/42/view", toSue.link)
        // Every other note carries the joined list, in position order.
        val toProvider = result.single { it.type == NotificationType.FEEDBACK_SENT_TO_PROVIDER }
        assertEquals("Subject Sam, Subject Sue", toProvider.params["subject"])
        val managerNotes = result.filter { it.type == NotificationType.FEEDBACK_SENT_TO_MANAGER }
        // Sue (4u) manages Sam but is a recipient herself — no manager note for her.
        assertEquals(setOf(9u, 8u), managerNotes.map { it.recipientId }.toSet())
        assertTrue(managerNotes.all { it.params["subject"] == "Subject Sam, Subject Sue" })
        assertEquals(5, result.size)
    }

    @Test
    fun `a manager's note names only the recipients who report to them`() {
        val managers = mapOf(9u to "Mia Manager", 8u to "Max Manager")
        // Mia manages Sam only, Max manages both.
        val byManager = mapOf(9u to setOf(2u), 8u to setOf(2u, 4u))
        val result = feedbackTransitionNotifications(
            42u, FeedbackStatus.DRAFT, multi(FeedbackStatus.SENT), multiNames, managers, byManager,
        )
        val notes = result.filter { it.type == NotificationType.FEEDBACK_SENT_TO_MANAGER }.associateBy { it.recipientId }
        assertEquals("Subject Sam", notes.getValue(9u).params["subject"])
        assertEquals("Subject Sam, Subject Sue", notes.getValue(8u).params["subject"])
        // Position order, not map order: a manager of Sue then Sam still reads "Sam, Sue".
        val reversed = feedbackCreationNotifications(42u, multi(FeedbackStatus.SENT), multiNames, managers, mapOf(8u to setOf(4u, 2u)))
        assertEquals("Subject Sam, Subject Sue", reversed.single { it.recipientId == 8u }.params["subject"])
    }

    @Test
    fun `withdrawing and creating as SENT fan out to every recipient`() {
        val withdrawn = feedbackTransitionNotifications(42u, FeedbackStatus.SENT, multi(FeedbackStatus.WITHDRAWN), multiNames)
        assertEquals(setOf(2u, 4u), withdrawn.map { it.recipientId }.toSet())
        assertTrue(withdrawn.all { it.type == NotificationType.FEEDBACK_WITHDRAWN_TO_SUBJECT })
        assertEquals("Subject Sue", withdrawn.single { it.recipientId == 4u }.params["subject"])

        val created = feedbackCreationNotifications(42u, multi(FeedbackStatus.SENT), multiNames)
        assertEquals(2, created.count { it.type == NotificationType.FEEDBACK_SENT_TO_SUBJECT })
        assertEquals("Subject Sam, Subject Sue", created.single { it.recipientId == 1u }.params["subject"])
    }

    @Test
    fun `a legacy self row is detected when the provider is any recipient`() {
        // provider 1u appears as the SECOND recipient: still a self row — nothing to the actor.
        val self = Feedback(
            subjectId = 2u,
            additionalSubjectIds = listOf(1u),
            providerId = 1u,
            visibility = FeedbackVisibility.PROVIDER_SUBJECT,
            status = FeedbackStatus.SENT,
        )
        val result = feedbackTransitionNotifications(7u, FeedbackStatus.DRAFT, self, multiNames)
        assertTrue(result.none { it.recipientId == 1u })
        assertEquals(listOf(2u), result.map { it.recipientId })
    }

    @Test
    fun `self-reflection transitions produce no notifications when there is no requester`() {
        // provider == subject, no requester: every recipient would be the acting user.
        val self = Feedback(
            requesterId = null,
            subjectId = 1u,
            providerId = 1u,
            visibility = FeedbackVisibility.PROVIDER_SUBJECT,
            status = FeedbackStatus.SENT,
        )
        assertTrue(feedbackTransitionNotifications(7u, FeedbackStatus.DRAFT, self, names).isEmpty())
        val withdrawn = self.copy(status = FeedbackStatus.WITHDRAWN)
        assertTrue(feedbackTransitionNotifications(7u, FeedbackStatus.SENT, withdrawn, names).isEmpty())
    }

    @Test
    fun `requested self-reflection transitions notify only the requester, self-worded`() {
        // provider == subject with a requester (the "request feedback from the subject" flow):
        // the acting provider/subject gets nothing, the requester hears about every step.
        val requestedSelf = Feedback(
            requesterId = 3u,
            subjectId = 1u,
            providerId = 1u,
            visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
            status = FeedbackStatus.SENT,
        )
        val sent = feedbackTransitionNotifications(8u, FeedbackStatus.DRAFT, requestedSelf, names)
        assertEquals(listOf(3u), sent.map { it.recipientId })
        assertEquals(NotificationType.FEEDBACK_SENT_TO_REQUESTER, sent.single().type)
        assertEquals("self", sent.single().params["self"])

        val pickedUp = feedbackTransitionNotifications(
            8u, FeedbackStatus.REQUESTED, requestedSelf.copy(status = FeedbackStatus.DRAFT), names,
        )
        assertEquals(listOf(3u), pickedUp.map { it.recipientId })
        assertEquals("self", pickedUp.single().params["self"])
    }

    @Test
    fun `creating a requested self-reflection words both notifications via the self contexts`() {
        val created = Feedback(
            requesterId = 3u,
            subjectId = 1u,
            providerId = 1u,
            visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
            status = FeedbackStatus.REQUESTED,
        )
        val result = feedbackCreationNotifications(11u, created, names)
        assertEquals(2, result.size)
        val toProvider = result.single { it.recipientId == 1u }
        val toRequester = result.single { it.recipientId == 3u }
        // The provider is asked for a self-reflection; the requester's confirmation uses the
        // distinct "reflection" context (its "self" context means subject == requester).
        assertEquals("self", toProvider.params["self"])
        assertEquals("reflection", toRequester.params["self"])
    }

    @Test
    fun `draft to sent without a requester notifies the subject and the provider`() {
        val next = feedback(FeedbackStatus.SENT, requesterId = null)
        val result = feedbackTransitionNotifications(7u, FeedbackStatus.DRAFT, next, names)
        assertEquals(setOf(2u, 1u), result.map { it.recipientId }.toSet())
        assertEquals("/feedback/7/view", result.single { it.recipientId == 1u }.link)
    }

    @Test
    fun `draft to sent notifies the provider with a view link`() {
        val next = feedback(FeedbackStatus.SENT)
        val toProvider = feedbackTransitionNotifications(42u, FeedbackStatus.DRAFT, next, names)
            .single { it.recipientId == 1u }
        assertEquals("/feedback/42/view", toProvider.link)
        assertEquals(NotificationType.FEEDBACK_SENT_TO_PROVIDER, toProvider.type)
        assertEquals(sam, toProvider.params["subject"])
    }

    @Test
    fun `subject link is omitted when the visibility hides it from the subject`() {
        // PROVIDER_REQUESTER: subject cannot read → no subject link; requester can → link present.
        val next = feedback(FeedbackStatus.SENT, FeedbackVisibility.PROVIDER_REQUESTER)
        val result = feedbackTransitionNotifications(9u, FeedbackStatus.DRAFT, next, names)
        assertNull(result.single { it.recipientId == 2u }.link)
        assertEquals("/feedback/9/view", result.single { it.recipientId == 3u }.link)
    }

    @Test
    fun `draft to sent with public visibility links both the subject and the requester`() {
        val next = feedback(FeedbackStatus.SENT, FeedbackVisibility.PUBLIC)
        val result = feedbackTransitionNotifications(13u, FeedbackStatus.DRAFT, next, names)
        assertEquals("/feedback/13/view", result.single { it.recipientId == 2u }.link)
        assertEquals("/feedback/13/view", result.single { it.recipientId == 3u }.link)
    }

    @Test
    fun `draft to sent with provider-subject visibility links the subject`() {
        // PROVIDER_SUBJECT implies no requester (the combination is contradictory otherwise).
        val next = feedback(FeedbackStatus.SENT, FeedbackVisibility.PROVIDER_SUBJECT, requesterId = null)
        val result = feedbackTransitionNotifications(14u, FeedbackStatus.DRAFT, next, names)
        assertEquals(setOf(2u, 1u), result.map { it.recipientId }.toSet())
        assertEquals("/feedback/14/view", result.single { it.recipientId == 2u }.link)
    }

    @Test
    fun `requested to sent notifies only the requester`() {
        // Not a legal edge of the state machine, but the mapping supports it explicitly (see the
        // comment in feedbackTransitionNotifications): only the requester note fires.
        val next = feedback(FeedbackStatus.SENT)
        val result = feedbackTransitionNotifications(21u, FeedbackStatus.REQUESTED, next, names)
        val n = result.single()
        assertEquals(3u, n.recipientId)
        assertEquals("/feedback/21/view", n.link)
        assertEquals(NotificationType.FEEDBACK_SENT_TO_REQUESTER, n.type)
    }

    @Test
    fun `requested to rejected notifies the requester with no link`() {
        val next = feedback(FeedbackStatus.REJECTED)
        val result = feedbackTransitionNotifications(5u, FeedbackStatus.REQUESTED, next, names)
        val n = result.single()
        assertEquals(3u, n.recipientId)
        assertNull(n.link)
        assertEquals(NotificationType.FEEDBACK_REJECTED_TO_REQUESTER, n.type)
        assertEquals(rita, n.params["requester"])
        assertEquals(pat, n.params["provider"])
        assertEquals(sam, n.params["subject"])
    }

    @Test
    fun `requested to draft notifies the requester that it was picked up`() {
        val next = feedback(FeedbackStatus.DRAFT)
        val result = feedbackTransitionNotifications(5u, FeedbackStatus.REQUESTED, next, names)
        val n = result.single()
        assertEquals(3u, n.recipientId)
        assertNull(n.link)
        assertEquals(NotificationType.FEEDBACK_PICKED_UP_TO_REQUESTER, n.type)
        assertEquals(rita, n.params["requester"])
        assertEquals(pat, n.params["provider"])
        assertEquals(sam, n.params["subject"])
    }

    @Test
    fun `sent to withdrawn notifies both subject and requester with no link`() {
        val next = feedback(FeedbackStatus.WITHDRAWN)
        val result = feedbackTransitionNotifications(8u, FeedbackStatus.SENT, next, names)
        assertEquals(setOf(2u, 3u), result.map { it.recipientId }.toSet())
        assertTrue(result.all { it.link == null })
        assertEquals(NotificationType.FEEDBACK_WITHDRAWN_TO_SUBJECT, result.single { it.recipientId == 2u }.type)
        val toRequester = result.single { it.recipientId == 3u }
        assertEquals(NotificationType.FEEDBACK_WITHDRAWN_TO_REQUESTER, toRequester.type)
        assertEquals(rita, toRequester.params["requester"])
    }

    @Test
    fun `sent to withdrawn without a requester notifies only the subject`() {
        val next = feedback(FeedbackStatus.WITHDRAWN, requesterId = null)
        val result = feedbackTransitionNotifications(8u, FeedbackStatus.SENT, next, names)
        assertEquals(listOf(2u), result.map { it.recipientId })
    }

    @Test
    fun `requested transitions without a requester notify no one`() {
        // Defensive: REQUESTED requires a requester (enforced in FeedbackService.validate), but
        // the pure mapping must stay total — with no requester there is nobody to notify.
        val rejected = feedback(FeedbackStatus.REJECTED, FeedbackVisibility.PROVIDER_SUBJECT, requesterId = null)
        assertTrue(feedbackTransitionNotifications(5u, FeedbackStatus.REQUESTED, rejected, names).isEmpty())
        val draft = feedback(FeedbackStatus.DRAFT, FeedbackVisibility.PROVIDER_SUBJECT, requesterId = null)
        assertTrue(feedbackTransitionNotifications(5u, FeedbackStatus.REQUESTED, draft, names).isEmpty())
    }

    @Test
    fun `abandoning a draft notifies like a retraction`() {
        // DRAFT -> WITHDRAWN lands in a delivered status: the record appears in the subject's
        // Received list, so subject + requester are told exactly like SENT -> WITHDRAWN.
        val next = feedback(FeedbackStatus.WITHDRAWN)
        val result = feedbackTransitionNotifications(6u, FeedbackStatus.DRAFT, next, names)
        assertEquals(setOf(2u, 3u), result.map { it.recipientId }.toSet())
        assertEquals(NotificationType.FEEDBACK_WITHDRAWN_TO_SUBJECT, result.single { it.recipientId == 2u }.type)
        assertEquals(NotificationType.FEEDBACK_WITHDRAWN_TO_REQUESTER, result.single { it.recipientId == 3u }.type)
        assertTrue(result.all { it.link == null })
    }

    @Test
    fun `an unmapped transition produces no notifications`() {
        // The mapping is total: a from/to pair outside the notification table yields nothing.
        val rejected = feedback(FeedbackStatus.REJECTED)
        assertTrue(feedbackTransitionNotifications(6u, FeedbackStatus.SENT, rejected, names).isEmpty())
        // Even landing on SENT only notifies when coming from DRAFT or REQUESTED — "resurrecting"
        // a terminal feedback (not an edge of the state machine) must not fan out notifications.
        val sent = feedback(FeedbackStatus.SENT)
        assertTrue(feedbackTransitionNotifications(6u, FeedbackStatus.WITHDRAWN, sent, names).isEmpty())
    }

    @Test
    fun `falls back to an id placeholder when a name is missing`() {
        val next = feedback(FeedbackStatus.REJECTED)
        val n = feedbackTransitionNotifications(5u, FeedbackStatus.REQUESTED, next, emptyMap()).single()
        assertEquals("#1", n.params["provider"])
        assertEquals("#2", n.params["subject"])
    }

    @Test
    fun `creating a requested feedback notifies the provider with an edit link and the requester without one`() {
        val created = feedback(FeedbackStatus.REQUESTED)
        val result = feedbackCreationNotifications(11u, created, names)
        assertEquals(2, result.size)

        val toProvider = result.single { it.recipientId == 1u }
        assertEquals("/feedback/11/edit", toProvider.link)
        assertEquals(NotificationType.FEEDBACK_REQUESTED_TO_PROVIDER, toProvider.type)
        assertEquals(rita, toProvider.params["requester"])
        assertEquals(sam, toProvider.params["subject"])

        // The requester gets a confirmation with no link, naming the provider and subject.
        val toRequester = result.single { it.recipientId == 3u }
        assertNull(toRequester.link, "the requester confirmation carries no link")
        assertEquals(NotificationType.FEEDBACK_REQUESTED_TO_REQUESTER, toRequester.type)
        assertEquals(pat, toRequester.params["provider"])
        assertEquals(sam, toRequester.params["subject"])
        assertNull(toRequester.params["self"], "not a self-request")
    }

    @Test
    fun `asking for feedback about yourself notifies the requester with the self variant`() {
        // The "ask for feedback about myself" flow: subject == requester.
        val created = Feedback(
            requesterId = 3u,
            subjectId = 3u,
            providerId = 1u,
            visibility = FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT,
            status = FeedbackStatus.REQUESTED,
        )
        val toRequester = feedbackCreationNotifications(12u, created, names)
            .single { it.recipientId == 3u }
        assertNull(toRequester.link)
        assertEquals(NotificationType.FEEDBACK_REQUESTED_TO_REQUESTER, toRequester.type)
        assertEquals("self", toRequester.params["self"])
    }

    @Test
    fun `creating a requested feedback without a requester produces no notification`() {
        // Defensive: unreachable through the API (REQUESTED requires a requester), but the pure
        // mapping must not blow up or invent a recipient.
        val created = feedback(
            FeedbackStatus.REQUESTED,
            FeedbackVisibility.PROVIDER_SUBJECT,
            requesterId = null,
        )
        assertTrue(feedbackCreationNotifications(11u, created, names).isEmpty())
    }

    @Test
    fun `creating a draft produces no notification`() {
        val created = feedback(FeedbackStatus.DRAFT)
        assertTrue(feedbackCreationNotifications(11u, created, names).isEmpty())
    }

    @Test
    fun `creating directly as sent notifies subject, provider and requester like the draft transition`() {
        // "Save & send" with a requester attached (API-only shape): same set as DRAFT -> SENT.
        val created = feedback(FeedbackStatus.SENT, FeedbackVisibility.PROVIDER_REQUESTER_SUBJECT)
        val result = feedbackCreationNotifications(42u, created, names)

        assertEquals(3, result.size)
        val toSubject = result.single { it.recipientId == 2u }
        assertEquals(NotificationType.FEEDBACK_SENT_TO_SUBJECT, toSubject.type)
        assertEquals(pat, toSubject.params["provider"])
        assertEquals(sam, toSubject.params["subject"])
        assertEquals("/feedback/42/view", toSubject.link)

        val toProvider = result.single { it.recipientId == 1u }
        assertEquals(NotificationType.FEEDBACK_SENT_TO_PROVIDER, toProvider.type)
        assertEquals(sam, toProvider.params["subject"])
        assertEquals("/feedback/42/view", toProvider.link)

        val toRequester = result.single { it.recipientId == 3u }
        assertEquals(NotificationType.FEEDBACK_SENT_TO_REQUESTER, toRequester.type)
        assertEquals(rita, toRequester.params["requester"])
        assertEquals("/feedback/42/view", toRequester.link)
    }

    @Test
    fun `creating directly as sent without a requester notifies the subject and the provider`() {
        val created = feedback(
            FeedbackStatus.SENT,
            FeedbackVisibility.PROVIDER_SUBJECT,
            requesterId = null,
        )
        val result = feedbackCreationNotifications(42u, created, names)
        assertEquals(setOf(2u, 1u), result.map { it.recipientId }.toSet())
        assertEquals("/feedback/42/view", result.single { it.recipientId == 2u }.link)
    }

    @Test
    fun `creating directly as sent gates the subject link on visibility`() {
        val created = feedback(FeedbackStatus.SENT, FeedbackVisibility.PROVIDER_REQUESTER)
        val result = feedbackCreationNotifications(42u, created, names)
        assertNull(result.single { it.recipientId == 2u }.link, "subject cannot read PROVIDER_REQUESTER")
        assertEquals("/feedback/42/view", result.single { it.recipientId == 3u }.link)
    }

    @Test
    fun `the subject's managers are notified when feedback lands in sent`() {
        // PROVIDER_REQUESTER hides the feedback from the subject, but manager read on delivered
        // feedback is not visibility-gated — the manager's view link is unconditional.
        val next = feedback(FeedbackStatus.SENT, FeedbackVisibility.PROVIDER_REQUESTER)
        val managers = mapOf(9u to "Manager Mo", 10u to "Manager Max")
        val result = feedbackTransitionNotifications(42u, FeedbackStatus.DRAFT, next, names, managers)

        val toManagers = result.filter { it.type == NotificationType.FEEDBACK_SENT_TO_MANAGER }
        assertEquals(setOf(9u, 10u), toManagers.map { it.recipientId }.toSet())
        toManagers.forEach {
            assertEquals(pat, it.params["provider"])
            assertEquals(sam, it.params["subject"])
            assertEquals("/feedback/42/view", it.link)
        }
    }

    @Test
    fun `managers who are themselves a party are not double-notified`() {
        val next = feedback(FeedbackStatus.SENT)
        // 1u is the provider, 3u the requester — both already notified in that role.
        val managers = mapOf(1u to pat, 3u to rita, 9u to "Manager Mo")
        val result = feedbackTransitionNotifications(42u, FeedbackStatus.DRAFT, next, names, managers)
        assertEquals(
            listOf(9u),
            result.filter { it.type == NotificationType.FEEDBACK_SENT_TO_MANAGER }.map { it.recipientId },
        )
    }

    @Test
    fun `creating directly as sent notifies the subject's managers too`() {
        val created = feedback(FeedbackStatus.SENT, FeedbackVisibility.PROVIDER_SUBJECT, requesterId = null)
        val result = feedbackCreationNotifications(42u, created, names, mapOf(9u to "Manager Mo"))
        val toManager = result.single { it.type == NotificationType.FEEDBACK_SENT_TO_MANAGER }
        assertEquals(9u, toManager.recipientId)
        assertEquals("/feedback/42/view", toManager.link)
    }

    @Test
    fun `manager notes only mint on a sent landing`() {
        // A withdrawal changes nothing for managers who could already read the delivered row.
        val withdrawn = feedback(FeedbackStatus.WITHDRAWN)
        val result = feedbackTransitionNotifications(
            42u, FeedbackStatus.SENT, withdrawn, names, mapOf(9u to "Manager Mo"),
        )
        assertTrue(result.none { it.type == NotificationType.FEEDBACK_SENT_TO_MANAGER })
    }

    @Test
    fun `a self-reflection keeps the manager note, self-worded`() {
        // provider == subject: the actor's own notes are dropped, but the manager is not the
        // actor — they are told their report shared a self-reflection.
        val created = Feedback(
            requesterId = null,
            subjectId = 1u,
            providerId = 1u,
            visibility = FeedbackVisibility.PROVIDER_SUBJECT,
            status = FeedbackStatus.SENT,
        )
        val result = feedbackCreationNotifications(42u, created, names, mapOf(9u to "Manager Mo"))
        val toManager = result.single()
        assertEquals(9u, toManager.recipientId)
        assertEquals(NotificationType.FEEDBACK_SENT_TO_MANAGER, toManager.type)
        assertEquals("self", toManager.params["self"])
    }

    @Test
    fun `a standalone self-reflection created as sent produces no notification`() {
        // provider == subject, no requester: every recipient would be the acting user.
        val created = Feedback(
            requesterId = null,
            subjectId = 1u,
            providerId = 1u,
            visibility = FeedbackVisibility.PROVIDER_SUBJECT,
            status = FeedbackStatus.SENT,
        )
        assertTrue(feedbackCreationNotifications(42u, created, names).isEmpty())
    }

    @Test
    fun `a requested self-reflection created as sent notifies only the requester, self-worded`() {
        val created = Feedback(
            requesterId = 3u,
            subjectId = 1u,
            providerId = 1u,
            visibility = FeedbackVisibility.PROVIDER_REQUESTER,
            status = FeedbackStatus.SENT,
        )
        val toRequester = feedbackCreationNotifications(42u, created, names).single()
        assertEquals(3u, toRequester.recipientId)
        assertEquals(NotificationType.FEEDBACK_SENT_TO_REQUESTER, toRequester.type)
        assertEquals("self", toRequester.params["self"])
    }

    @Test
    fun `creation params fall back to an id placeholder when a name is missing`() {
        val created = feedback(FeedbackStatus.REQUESTED)
        val toProvider = feedbackCreationNotifications(11u, created, emptyMap())
            .single { it.recipientId == 1u }
        assertEquals("#3", toProvider.params["requester"])
        assertEquals("#2", toProvider.params["subject"])
    }

    @Test
    fun `deleting a feedback with a requester notifies them without a link`() {
        val deleted = feedback(FeedbackStatus.DRAFT) // requesterId = 3u by default
        val n = feedbackDeletionNotifications(deleted, names).single()
        assertEquals(3u, n.recipientId, "the requester is notified")
        assertNull(n.link)
        assertEquals(NotificationType.FEEDBACK_DELETED_TO_REQUESTER, n.type)
        assertEquals(pat, n.params["provider"])
        assertEquals(sam, n.params["subject"])
    }

    @Test
    fun `deleting a feedback without a requester produces no notification`() {
        val deleted = feedback(
            FeedbackStatus.DRAFT,
            FeedbackVisibility.PROVIDER_SUBJECT,
            requesterId = null,
        )
        assertTrue(feedbackDeletionNotifications(deleted, names).isEmpty())
    }

    // ── Request expiration (v3.8.0) ───────────────────────────────────────────

    @Test
    fun `an expired request notifies the requester, naming both parties`() {
        val expired = feedback(FeedbackStatus.REQUESTED) // requesterId = 3u by default
        val n = feedbackExpiredToRequesterNotification(expired, names)
        assertEquals(3u, n.recipientId)
        assertEquals(NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER, n.type)
        assertEquals(rita, n.params["requester"])
        assertEquals(pat, n.params["provider"])
        assertEquals(sam, n.params["subject"])
        assertNull(n.link)
    }

    @Test
    fun `an expired request notifies the provider, naming both parties`() {
        val expired = feedback(FeedbackStatus.REQUESTED)
        val n = feedbackExpiredToProviderNotification(expired, names)
        assertEquals(1u, n.recipientId)
        assertEquals(NotificationType.FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER, n.type)
        assertEquals(rita, n.params["requester"])
        assertEquals(pat, n.params["provider"])
        assertEquals(sam, n.params["subject"])
        assertNull(n.link)
    }

    @Test
    fun `expiry params fall back to an id placeholder when a name is missing`() {
        val expired = feedback(FeedbackStatus.REQUESTED)
        val n = feedbackExpiredToProviderNotification(expired, emptyMap())
        assertEquals("#3", n.params["requester"])
        assertEquals("#2", n.params["subject"])
        assertEquals("#1", n.params["provider"])
    }
}
