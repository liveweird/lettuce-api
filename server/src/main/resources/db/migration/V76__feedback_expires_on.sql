-- Feedback request expiration (v3.8.0): an optional deadline on a REQUESTED feedback request.
-- Meaningful only while REQUESTED — set once at creation (the requester_message precedent),
-- never updated by PUT. Strict-ISO VARCHAR(10) so lexicographic order == chronological (the
-- goals.due_date / days-off business-date convention); NULL = indefinite (today's behaviour,
-- unchanged for every existing row). The lazy sweep (FeedbackService.expireOverdueRequests)
-- scans this column for overdue REQUESTED rows at read time — see
-- "Feedback request expiration" in .claude/docs/features/feedbacks.md.
ALTER TABLE feedbacks ADD COLUMN expires_on VARCHAR(10);
CREATE INDEX idx_feedbacks_expires_on ON feedbacks(expires_on) WHERE expires_on IS NOT NULL;
