# E2E (Playwright, blackbox)

Browser end-to-end tests that treat the app as a **blackbox**: they drive a real Chromium against
the whole stack (SPA + server + Flyway + Postgres) served single-origin at `http://localhost:8080`
by `docker compose`. This package is fully isolated from `web/` — it imports none of the app source
and only speaks HTTP/DOM.

## Run

```bash
cd e2e
npm install
npm run install:browsers      # one-time: download Chromium
npm test                      # brings the stack up (docker compose), runs specs, tears it down
```

- `global-setup.ts` starts `docker compose up -d --build` and waits for `:8080` — **unless a stack
  is already running there**, which it reuses (fast local iteration: keep `docker compose up` or a
  local `WEB_STATIC_DIR=… ./gradlew :server:run` going and just run `npm test`). `global-teardown.ts`
  only runs `docker compose down -v` if setup started the stack.
- Requires Docker. Override the target with `E2E_BASE_URL`.
- **A TLS target with a self-signed certificate** (the local ingress proof in the `run-stack`
  skill): `E2E_BASE_URL=https://lettuce.<ip>.nip.io E2E_INSECURE_TLS=1 npm test` — the flag sets
  `ignoreHTTPSErrors` for the browser and `NODE_TLS_REJECT_UNAUTHORIZED=0` for the helpers' plain
  `fetch`. The target must run in **development mode with pristine seeds** (a production boot
  disables the demo users for good), and the three Mailpit specs skip unless something answers on
  `localhost:8025` — keep `docker compose` down so they don't find the compose Mailpit and time out.

Two Docker-free static gates ride every spec change (2026-08 — run both before merging, like
the web package's lint/knip):

```bash
npm run typecheck             # tsc --noEmit — Playwright only TRANSPILES TS, it never checks it
npm run check:scenarios       # spec ↔ scenario parity: files exist, test() titles == headings
```

`check:scenarios` enforces the same-commit rule below mechanically (both directions, orphan
files included); `accessibility.spec.ts` is its one registered skip — the parameterized-title
carve-out in [`scenarios/README.md`](scenarios/README.md).

## Parallel execution

The suite runs on **4 workers by default** (`E2E_WORKERS` overrides; `E2E_WORKERS=1` restores the
old fully-serial behavior). The serial unit is the **spec file** (`fullyParallel: false` — some
files' tests are order-dependent, e.g. `users-import`); different files run concurrently. That is
only sound because **every spec file owns its server-side state exclusively** — the standing rule
for any new or edited spec:

- **Shared read-mostly actor**: `Manager CCC` signs in from `goals.spec.ts` (the skip-level chain create), `kudos.spec.ts`, and `pulse.spec.ts` — none of them mutates CCC's own account/team state, so no collision exists today; a future spec giving Manager CCC owned mutable state must check these three first.
- **Feedbacks**: each file owns its provider × recipient pairs outright (the server's per-recipient no-duplicate rule since v3.1.0 — a draft from P naming X blocks every other open P→X draft, whatever the other recipients) — the server
  409s a create while an *open* (DRAFT/REQUESTED) duplicate exists, and identically-worded bell
  cards collide. Current ownership: delivery = (AAA One ← AAA Two), provide = (AAA Two + AAA Three ← AAA One — one two-recipient draft),
  lifecycle-rest = (AAA Two ← Manager AAA), hr = (AAA Three ← Manager AAA), manager-oversight =
  (AAA One ← Manager AAA, created directly as SENT — no open window), triage = the two
  self-requested (AAA One/Two ← Manager AAA) triples, third-party = (AAA One ← AAA Three, req.
  Manager AAA), kudos = (AAA Three ← AAA Two, created
  directly as SENT — no open window). Pick an unclaimed triple or a throwaway.
- **Impact-log journals are per-owner state**: `impact-log.spec` exclusively owns AAA Two's
  journal (entries deleted in-test with an API `afterEach` fallback); a future spec touching
  impact-log rows must pick another owner or a throwaway.
- **Bells**: presence asserts on a seed account's bell must be text-filtered
  (`notificationCard`); *count/badge/mark-all-as-seen* asserts belong only on a **throwaway**
  recipient (`notifications.spec` is the template) — seed bells receive concurrent traffic.
- **Global documents/registries have one writer file each**: dictionaries — `dictionaries.spec`
  edits `seniority-levels`, `user-career.spec` edits `career-paths`; review periods —
  `performance-reviews.spec`; public holidays + the paid-leave pool kinds ("E2E Pool") + AAA
  Two's days-off/pools/allowances/corrections — `days-off.spec`; templates — `templates.spec`
  (unique names).
- **Residue sweep + the marker contract (v2.34.0)**: `global-setup.ts` sweeps PREVIOUS runs'
  throwaway entities off the shared volume before any worker starts (`sweep-residue.ts` —
  soft-deletes teams whose name contains `E2E`, then users whose email contains `e2e`; teams
  first, so deleted managers don't strand org-chart nodes). The contract cuts both ways: every
  e2e-created user's EMAIL must contain `e2e` (the `createUserViaUi` derivation guarantees it)
  and every e2e-created team's NAME must contain `E2E` — and nothing that must SURVIVE runs may
  ever be named that way. Un-sweepable residue (dictionary values, closed/cancelled pulse
  cycles, cancelled days-off rows) is known-inert and stays.
- **`alerts.spec` and `pulse.spec` each run in their own project phase after everything else**
  (config `dependencies`, chained: chromium → alerts → pulse): an active alert overlays the
  header for every worker, and a pulse cycle sprays notifications at EVERY user's bell while the
  one-non-terminal-cycle registry is global. `pulse.spec` exclusively owns that registry — it
  sweeps stranded SCHEDULED/OPEN cycles at the start (admin API cancel) and leaves the registry
  terminal; every run accretes one CLOSED (+ one CANCELLED) cycle on the shared DB, so its
  results asserts pin the current cycle, never cycle #1. Any new spec minting globally-visible
  state joins a phase like these.
- Artifacts must be unique-named (`uniqueText`) and list asserts filter- or sort-anchored — never
  bare page-1 assumptions.

## What's covered

Real user journeys, prioritizing the feedback lifecycle (which validates the POST-action verb
endpoints through the UI). **Each spec's full design lives in its scenario file under
[`scenarios/`](scenarios/README.md)** — versioned natural-language test-design artifacts (actors,
owned state, numbered steps, expected outcomes). **A new or behaviorally changed test lands with
its scenario file and its line below in the same commit** — this list is the coverage map, the
scenario file is the design.

- [`accessibility.spec.ts`](scenarios/accessibility.md) — axe WCAG A/AA smoke: login + 27 authed pages (incl. the kudos/feedback/days-off create forms, `/feature-flags`, the v2.36.0 impact-log pair, the v2.42.0 succession pair, the v3.0.0 `/integration-clients`, and the v3.2.0 `/days-off-pools` registry) + the two v3.3.0 chrome states (the open notifications panel, the collapsed icon rail); no waived rules since the v3.3.0 colour pass.
- [`alerts.spec.ts`](scenarios/alerts.md) — admin broadcast alert: banner, hide/re-show, deactivate, delete (own serial phase).
- [`auth.spec.ts`](scenarios/auth.md) — login / logout / invalid credentials.
- [`changelog.spec.ts`](scenarios/changelog.md) — the bundled release history renders versioned entries in EN and PL (PL leg on a throwaway user — the switch persists server-side).
- [`dashboard-my-teams.spec.ts`](scenarios/dashboard-my-teams.md) — the My teams tab, team-details drill-down round-trip, non-manager empty state.
- [`days-off.spec.ts`](scenarios/days-off.md) — requests (paid/unpaid, half-days), the manager-set yearly allowance on the drill-down with the owner's bell (v2.32.0 — the admin edit page lost the field), manager accept/reject, calendar, budgets + corrections, the mandatory-reason cancel — owner-side AND the manager-side chain cancel with the reason popover + bell receipt (v2.31.0) — the manager's on-behalf auto-accepted recording (v2.29.0), and the paid pools (v3.2.0): the admin's pool-kind registry, the manager's Add pool grant + archive on the drill-down, and a request booked from the extra pool via the Type picker.
- [`dictionaries.spec.ts`](scenarios/dictionaries.md) — the whole-list dictionary editor (add/reorder/rename, multilingual — EN required, translations optional) + the read-only view with EN fallback.
- [`email-notifications.spec.ts`](scenarios/email-notifications.md) — the per-user email-mirror opt-out toggle (self + the admin-for-another-user branch, 2026-08).
- [`error-handling.spec.ts`](scenarios/error-handling.md) — the SPA's failure surfaces under injected network faults (the suite's first `page.route` interception specs, v2.34.0): load-error alerts, save-error inline alerts, and the refresh transient-vs-rejected split.
- [`feature-flags.spec.ts`](scenarios/feature-flags.md) — per-user feature flags end to end + the per-feature screen's team bulk toggle.
- [`feedback-delivery.spec.ts`](scenarios/feedback-delivery.md) — the receiving side: draft invisibility, Received list, bell deep link.
- [`feedback-lifecycle-rest.spec.ts`](scenarios/feedback-lifecycle-rest.md) — create-as-SENT, provider draft delete, History/Lifecycle tabs.
- [`feedback-provide.spec.ts`](scenarios/feedback-provide.md) — provide → draft → send → withdraw (entry via the /feedback New-feedback button + the multi-recipient picker — AAA Two + AAA Three, v3.1.0; the view page names both).
- [`feedback-request-third-party.spec.ts`](scenarios/feedback-request-third-party.md) — manager requests feedback about a subordinate from a third party; requester message rides along; the v3.8.0 expiration-preset picker sets a deadline the provider sees before deciding.
- [`feedback-request-triage.spec.ts`](scenarios/feedback-request-triage.md) — ask → accept → send; and reject.
- [`goals.spec.ts`](scenarios/goals.md) — the goal lifecycle, PLAN milestones, chain-manager visibility, the skip-level chain create (v2.33.0), notifications, the dirty-form navigation guard — a sidebar click held by the discard confirm (v3.6.0).
- [`hr.spec.ts`](scenarios/hr.md) — the HR auditor reads a private draft via the Audit section + the guarded career timeline (2026-08); admin gets no audit surface.
- [`i18n.spec.ts`](scenarios/i18n.md) — language menu switch (native names) on a throwaway user, persisted across reload AND re-login (the v2.21.0 server-side sync).
- [`impact-log.spec.ts`](scenarios/impact-log.md) — the accomplishment journal (v2.36.0): owner creates/edits/deletes with History, the manager reads via My subordinates' journals and the person-card Impact-log drill-down (v2.38.0).
- [`integration-clients.spec.ts`](scenarios/integration-clients.md) — the v3.0.0 integration API: admin mints a show-once key, a machine client reads via GraphQL, revoke kills it, non-admins see nothing.
- [`kudos.spec.ts`](scenarios/kudos.md) — a kudo created from the wall's New kudo screen (recipient picker, visibility pinned Public) lands there for a non-party.
- [`lists.spec.ts`](scenarios/lists.md) — shared list plumbing: filters, sort toggle, page size.
- [`manager-oversight.spec.ts`](scenarios/manager-oversight.md) — the My team feedback tab and the per-user two-way screen.
- [`mfa.spec.ts`](scenarios/mfa.md) — opt-in email MFA at login incl. the five-failure attempt cap + fresh-challenge recovery (Mailpit-gated).
- [`navigation.spec.ts`](scenarios/navigation.md) — shell navigation: the in-shell 404 catch-all, the legacy performance redirects, the dashboard Peers tab (2026-08 audit round).
- [`notifications.spec.ts`](scenarios/notifications.md) — bell mechanics: badge, seen/unseen, mark all, delete.
- [`one-on-ones.spec.ts`](scenarios/one-on-ones.md) — documenting 1:1s, action-item carry-over, subordinate notification.
- [`org-chart.spec.ts`](scenarios/org-chart.md) — the org-chart canvas and its drill-downs, plus the v2.40.0 team collapse/expand (cascading fold of a hidden member's own subtree).
- [`password-reset.spec.ts`](scenarios/password-reset.md) — the Forgot-password flow (neutral answers, working new password; Mailpit-gated).
- [`performance-reviews.spec.ts`](scenarios/performance-reviews.md) — review periods, the full review lifecycle, Distribution + Quadrants views.
- [`pulse.spec.ts`](scenarios/pulse.md) — the pulse cycle end to end: schedule/open/fill/monitor/close/results/trend/cancel (own serial phase).
- [`succession.spec.ts`](scenarios/succession.md) — succession plans (v2.42.0): create for a report (criticality/risk sliders since v2.44.0), nominate a successor with the modal-created linked development goal, the under-bench cue, the one-primary confirm-demote on a second PRIMARY nomination (v2.43.0), the Review screen's Complete-review stamp + Close warning (v2.44.0), the gap filled-flag tick + strikethrough (v2.45.0), the History tab's localized event trail (v2.46.0), the person-card Succession-plan button on the owner's subordinates grid (v2.47.0), invisibility to the seat's person, close (read-only) + list-row delete.
- [`team-kpis.spec.ts`](scenarios/team-kpis.md) — the team-KPI lifecycle, data points + graph, member notifications, the v2.26.0 member data entry (add row live, lifecycle withheld), the v2.41.0 target direction (at-most flip, "≤" target render, per-value Vs-target deltas).
- [`teams.spec.ts`](scenarios/teams.md) — team CRUD, roster edits, admin-only manager reassignment.
- [`templates.spec.ts`](scenarios/templates.md) — template CRUD + Insert into the feedback editor.
- [`tour.spec.ts`](scenarios/tour.md) — the guided tour's landmark order as manager and admin.
- [`user-career.spec.ts`](scenarios/user-career.md) — the career-position timeline, the v2.39.0 past-insert backfill (taken-date + date-neighbor sameness notes), Career page + Team pyramid + time slider, dictionary rename propagation, the v2.25.0 self/chain/HR read privacy (no career link on manager cards; direct URL refused).
- [`user-details.spec.ts`](scenarios/user-details.md) — the read-only user-details card in every relationship flavor + the Teams membership view.
- [`user-edit.spec.ts`](scenarios/user-edit.md) — admin creates (password reveal) and renames a user.
- [`users-admin.spec.ts`](scenarios/users-admin.md) — roles, password reset vs self-change, deactivate/reactivate, delete.
- [`users-import.spec.ts`](scenarios/users-import.md) — mass CSV import; re-import yields duplicates.
- [`welcome-email.spec.ts`](scenarios/welcome-email.md) — create-with-email: the welcome mail's password signs in (Mailpit-gated).

Specs log in with the seeded accounts (`admin@lettuce.local`, `manager-aaa@…`, `aaa-one/two/three@…`,
all password `changeme`), capture created ids from API responses so they act on their own rows, and
use unique content — so they don't depend on a clean database or absolute counts. Mutating specs
(rename/role/password/delete) only ever touch throwaway users they create through the UI; seeded
accounts are never mutated. The onboarding tour is suppressed via an init script (see
`tests/helpers.ts`).

### Logging in

`helpers.login()` has two paths. For a **seeded account with the seed password** it mints a session
over the API and writes the five `lettuce.auth.*` localStorage keys the SPA itself persists
(`sessions.ts`) — equivalent to having driven the form, minus the typing, a navigation, and the
stored-language application (only the real form/refresh path runs `persistSession`, which applies
`LoginResponse.language` to the UI — v2.21.0; language-sensitive journeys must use
`loginWithPassword()`). A full run does ~90 logins. The session is minted **per call**, not cached: `logout()` revokes
both tokens server-side, so a session reused across specs would be a revoked one (the app then
shows "You've been signed out"). If an injected session doesn't authenticate, the helper falls back
to a real login — slow, never wrong.

Everything else takes `loginWithPassword()`, the real form driver: any throwaway user, and any call
passing an explicit password. That keeps the specs whose subject *is* a credential honest —
`users-import` (the imported one-time password), `password-reset` (the new password), `users-admin`
(reset / self-changed / deactivated / deleted accounts), `performance-reviews` and `hr` (generated
passwords), and `feature-flags` (the fresh login is what proves the flags took effect).
`auth.spec.ts`'s "log in and log out" calls `loginWithPassword` explicitly — it exists to exercise
the form. Development stacks also lift the per-IP login bucket
(`security.rateLimit.loginPerMinute`, 1000/min in development vs 10/min in production), so the
remaining real logins aren't throttled either.

## Deliberately not covered

- **Login lockout (429)** — five failed logins would lock a seeded account for 15 minutes in the
  shared database and poison the rest of the run. Covered by `LoginThrottleTest` /
  `LoginLockoutTest` (server).
- **Token refresh / expiry (clock-driven)** — real expiry needs clock control; covered by
  server tests and the `web/src/api/api.test.ts` unit tests. The browser-side refresh
  BEHAVIOR (transient failure keeps the session, rejection signs out) IS covered since
  v2.34.0 by `error-handling.spec.ts`, which forces the refresh path via `page.route`
  interception instead of waiting out the token.
- **The authz / visibility matrix** — exhaustively covered by `AuthorizationTest` (server); E2E
  asserts only user-visible consequences (a draft hidden from its subject, notification links).
- **`DRAFT → WITHDRAWN` (abandon a draft)** — a valid backend transition with no UI affordance
  (the editor offers Delete instead), so it cannot be exercised through the browser.
- **Dark-mode rendering** — the theme toggle is unit-tested and the palette is theme-owned
  (`web/src/theme.ts`); no e2e asserts colors, and there is no visual-regression suite.
- **Responsive / cross-browser / visual automation** — the suite deliberately runs Desktop
  Chrome only, with no mobile project or screenshot comparison; layout relies on Mantine
  semantics plus the role/label-based locators every spec already uses. Accessibility gets
  the `accessibility.spec.ts` axe smoke (see above) — every WCAG 2.0/2.1 A+AA rule un-waived since v3.3.0 (`color-contrast` included).

Reports/artifacts land in `playwright-report/` and `test-results/` (git-ignored).
