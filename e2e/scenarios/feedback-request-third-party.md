# Third-party feedback request with a requester message

- **Spec**: [tests/feedback-request-third-party.spec.ts](../tests/feedback-request-third-party.spec.ts)
- **Actors**: Manager AAA (requester), AAA One (subject), AAA Three (provider) — seed accounts
- **Owns** (exclusive server-side state): the (subject AAA One ← provider AAA Three,
  requester Manager AAA) feedback triple — one row per test, sequential within the file, so the
  second test's REQUESTED row is created only once the first has closed its own row to SENT
- **Since**: v3.8.0 adds the expiration-preset scenario below

The manager-driven request flow (distinct from the self "Ask for feedback"): a manager
requests feedback ABOUT a subordinate FROM a third party, with a requester message. The
message rides along read-only through triage and the draft editor, and the requester is
notified on pick-up and on send.

## Scenario: manager requests feedback about a subordinate; provider sees the message, accepts and sends

1. Manager AAA signs in, opens the Dashboard's "My subordinates" tab, and from AAA One's
   card's Feedback dropdown (v1.51.0) chooses "Request feedback about AAA One".
   - *Expected*: the request-feedback screen opens.
2. Manager AAA adds AAA Three as a provider, writes a unique "Message to the provider", and
   clicks "Request".
   - *Expected*: the request is created; Manager AAA signs out.
3. AAA Three signs in and opens the request.
   - *Expected*: the "Feedback request" triage screen states "Manager AAA requested feedback
     from you about AAA One." and shows the requester's message read-only.
4. AAA Three clicks "Accept".
   - *Expected*: the screen becomes the draft editor; the requester's message is still
     readable there, behind a collapsed "Message from the requester" toggle that expands
     on click.
5. AAA Three writes a unique feedback text, clicks "Save & send", and signs out.
6. Manager AAA signs in and opens the notification bell.
   - *Expected*: two cards are present — "AAA Three is now drafting feedback about AAA One."
     (the pick-up) and "The feedback you requested from AAA Three about AAA One has been
     sent." (the delivery).
7. Manager AAA opens the feedback's view page.
   - *Expected*: the content is visible and the status reads "Sent" — the default visibility
     (Provider + requester + subject) includes the requester.

## Scenario: a fixed-duration expiration preset is set on the request and shown to the provider before they decide

1. Manager AAA signs in, opens the Dashboard's "My subordinates" tab, and from AAA One's
   card's Feedback dropdown chooses "Request feedback about AAA One".
   - *Expected*: the request-feedback screen opens.
2. Manager AAA adds AAA Three as a provider, picks "In 1 week" from the Expiration select, and
   clicks "Request".
   - *Expected*: the request is created carrying the resolved `expiresOn` date one week out;
     Manager AAA signs out.
3. AAA Three signs in and opens the request.
   - *Expected*: the "Feedback request" triage screen shows an "Expires on" row with that same
     date, before AAA Three accepts or rejects.
4. AAA Three clicks "Reject" and confirms in the dialog.
   - *Expected*: the request is rejected (closing the row so the triple stays free for a rerun
     of this file); AAA Three signs out.

## Not covered here (and why)

The time-based auto-reject sweep (a REQUESTED row's `expiresOn` actually elapsing) is a
server-side behavior with no UI to drive it deterministically — covered by
`FeedbackExpiryTest` (server test suite), not here.
