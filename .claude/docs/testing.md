### Testing

**Automatic CI gates.** `.github/workflows/quality.yml` runs for every pull request, pushes to
`master`, and manual dispatches without path filters. Its least-privilege, independent jobs run the
following checks on JDK 21 and Node 24:

- **Backend:** `./scripts/test-render-app-deployment.sh` checks release image validation;
  `python3 -m unittest discover -s scripts -p 'test_*.py'` checks the offline recovery
  schema comparator; `./scripts/test-docker-build-context.sh` verifies that Docker includes
  Git refs for `build/*` branches while excluding generated output and dependency caches;
  then `./gradlew --dependency-verification strict check :server:installDist`
  runs the Kotlin tests, Detekt, Kover verification, dependency alignment, and distribution packaging.
  CI requires the committed lock/checksum files and checks they remain unchanged. See
  `.claude/docs/dependency-reproducibility.md` for intentional dependency updates.
  The tests require the GitHub-hosted runner's Docker daemon for
  Testcontainers.
- **Web:** a lockfile install with `npm ci --legacy-peer-deps`, followed by `npm run build`,
  `npm run lint`, `npm run knip`, and `npm run test:coverage`.
- **API contract:** Spectral CLI 6.15.0 with the repository ruleset at error severity, then
  `npm run gen:api` and a clean-diff assertion for `web/src/api/schema.ts`.
- **E2E source:** a lockfile install followed by `npm run typecheck` and
  `npm run check:scenarios`.

The full Playwright browser journey remains an on-demand, manual workflow in
`.github/workflows/e2e.yml`; the pull-request gate checks its TypeScript and spec/scenario pairing
without starting the stack or downloading Chromium. The stable quality job IDs and display names
for required-check rules are `backend` (**Backend**), `web` (**Web**), `api-contract`
(**API contract**), and `e2e-static` (**E2E source**). Since 2026-09-06, the active
repository ruleset requires all four checks from the GitHub Actions app on `master`,
with strict up-to-date checking. Existing PR, deletion, and non-fast-forward protections
remain in place, with no bypass actors. These settings live in GitHub, separately from
the workflow file; preserve the check names when editing the workflow. **The browser e2e suite is
dispatch-only in CI** (`workflow_dispatch`, no `push`/`pull_request` trigger) — **the LOCAL e2e run
below is the actual gate** for that suite before a merge; the CI workflow exists only for on-demand
confirmation, and it now carries a top-level `permissions: contents: read` (least-privilege — it
only checks out the repo and uploads its own report artifact).

**Local pre-merge gate sequence.** Run these in this order, non-overlapping (never the server
suite and e2e at once — they contend on shared rate-limit buckets and produce timeout flakes that
read as real failures) — and never `docker compose down -v` against a long-lived dev/e2e volume:

1. `cd web && npm run gen:api` — regenerates `web/src/api/schema.ts` from the OpenAPI spec, then
   `git diff --exit-code -- web/src/api/schema.ts` (the local twin of the **API contract** CI job's
   clean-diff assertion — a spec change, even a description-only edit, can still change the
   generated types; the CI job fails the same way if the committed file drifts).
2. `./gradlew --dependency-verification strict check :server:installDist` (`--rerun` on
   `:server:test` if you need a clean, non-cached run), then
   `git diff --exit-code -- gradle.lockfile core/gradle.lockfile server/gradle.lockfile settings-gradle.lockfile gradle/verification-metadata.xml`
   (the local twin of the **Backend** CI job's lock/checksum clean-diff check — see
   `.claude/docs/dependency-reproducibility.md` for an intentional dependency update instead of
   fighting this check).
3. The full e2e suite (see "E2E scenarios" below and `e2e/README.md` for run recipes) — only after
   1 and 2 are clean.

`server/src/test/kotlin/ServerTest.kt` uses `io.ktor.server.testing.testApplication` and overrides the `postgres.*` config keys via `MapApplicationConfig` to point at a Testcontainers `PostgreSQLContainer` started lazily by `PostgresTestSupport`. Running tests requires a working Docker daemon (Docker Desktop, OrbStack, etc.). When adding tests, replicate the `environment { config = ApplicationConfig("application.yaml").mergeWith(MapApplicationConfig(...)) }` block so the app boots against the test container rather than a real database. The container runs **all** Flyway migrations, so the V6/V9/V14 seeds (admin, demo org, default templates) are present — tests scope their assertions with unique prefixes/filters rather than asserting absolute counts.

**Coverage gates.** Backend Kover enforces line- and branch-coverage floors in `server/build.gradle.kts` (`minBound(90)` line, `minBound(69)` branch, wired into `check` via `koverVerify`). Frontend vitest enforces thresholds in `web/vite.config.ts` (`test.coverage.thresholds`); run `cd web && npm run test:coverage`. All are floors below current actuals — keep new code covered or they fail.

**Static analysis (detekt).** `./gradlew detekt` runs detekt over `core` + `server` (plain rule sets, no type resolution) and rides `check`, so `build` fails on any finding — the gate is zero findings with **no baseline file**. Repo tuning lives in `config/detekt/detekt.yml`, layered on the bundled defaults; every override there carries a one-line comment naming the deliberate idiom it protects (wildcard Ktor imports, the flat feature-package layout, declarative `*Routes.kt` registrars, the validation-throw convention, one-service-per-feature, guard-clause returns). Fix new findings in code first; extend the config only for a genuinely deliberate idiom, and prefer a config override over `@Suppress` (a per-site `@Suppress` needs a one-line justifying comment). Runs in seconds, no Docker — safe to run anytime, unlike the test suite. Its sibling `:server:checkDependencyAlignment` (also on `check`, Docker-free) fails when an aligned dependency family — `io.netty` (Ktor engine + reactor-netty via the Netty BOM), `io.opentelemetry` incl. `-alpha`/incubator artifacts (the instrumentation alpha BOM in core), kotlin-stdlib/kotlin-reflect (reflect declared explicitly) — resolves to several versions on the runtime classpath (2026-09-04).

**Frontend static analysis (sonarjs + knip).** The SPA's counterpart, same zero-findings/no-baseline policy: `cd web && npm run lint` carries `eslint-plugin-sonarjs` (recommended set) plus core size/complexity backstops tuned generously for React's one-function-per-page architecture (`cognitive-complexity` 40, `complexity` 50, `max-lines-per-function` 700 — backstops against future monsters, not targets); every override in `web/eslint.config.js` carries the idiom comment. `cd web && npm run knip` is the dead-code gate (unused files/exports/dependencies; test files count as entries, so a flagged export is unused even by tests) — the generated `src/api/schema.ts` is excluded from both (type-checked by `tsc`, not style-linted).

**Runtime OpenAPI conformance.** Every `/api/` interaction the server test suite produces is validated against `documentation.yaml` by the `OpenApiConformance` Ktor client plugin (`server/src/test/kotlin/OpenApiConformance.kt`), installed via the shared `lettuceTestClientDefaults()` in `TestEnvironment.kt` — so `jsonClient()`/`authedClient()` traffic is checked automatically and drift (undeclared endpoint/method/status, response-schema or content-type mismatch) fails the exercising test with the validation report. Response side is fully validated; request-side validation is ignored except unknown-path/method (tests deliberately send malformed payloads and missing tokens). The spec is fed to the validator relabeled 3.0.3 in memory (swagger-request-validator's 3.1 support is unreliable); `OpenApiSpecTest` pins that the document stays 3.0-compatible (use `nullable:`, never `type: [..., "null"]`) plus static invariants (unique operationIds, 401/500 declared, paths under `/api/v1/`). `-Dopenapi.conformance=warn|off` relaxes enforcement for drift triage only. A coverage report (exercised vs. declared operation/status pairs) is written to `server/build/reports/openapi-conformance/coverage.md` after each test run — a report, not a gate. Tests that use `testApplication`'s default `client` bypass the plugin — prefer `jsonClient()`.

**Schemathesis (optional manual fuzz pass, not in CI).** Property-based fuzzing of the running stack from the spec: `docker compose up --build` (compose already ships dev mode, so `/openapi` is exposed), grab a token — `TOKEN=$(curl -s -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' -d '{"email":"admin@lettuce.local","password":"changeme"}' | jq -r .token)` — then `uvx schemathesis run -c all -H "Authorization: Bearer $TOKEN" --exclude-path /api/v1/logout --exclude-method DELETE http://localhost:8080/openapi/documentation.yaml --url http://localhost:8080`. The exclusions are load-bearing: fuzzing `/logout` **revokes the bearer token** (everything after 401s), and fuzzing `DELETE /users/{id}` as admin **soft-deletes the admin account itself** (then a fuzz `POST /users` can grab the freed `admin@lettuce.local` email — recover via `docker compose exec postgres psql`: quarantine the impostor row, `update users set marked_as_deleted = false where id = 1`). Login fuzzing also trips the per-account lockout for `admin@lettuce.local` (the spec's example email) — in-memory, so `docker compose restart app` clears it. Expect residual noise from stateful invariants the spec cannot express (no-duplicate 409s, transition rules, rate-limit 429s, TRACE probes, open schemas ignoring junk params); a **`Server error` count above zero is the real signal**. It complements, not replaces, the suite-piggybacked conformance layer above; the fuzz DB junk lives only in the compose volume (`docker compose down -v` resets). Needs `uv` (or `pipx`); no Python dependency lives in the repo. First run (2026-07-22) found two 500s, both fixed: oversized passwords blowing up bcrypt (create/change 400 via `validatePassword` — the contract is ≤ 71 UTF-8 bytes since v2.18.1, `MAX_PASSWORD_BYTES` in `auth/Passwords.kt`; login 401 via the `verifyPassword` guard — the 500-vs-401 split was an account-enumeration oracle) and NUL bytes in stored text (PostgreSQL 22021 → central 400 mapping in `ErrorHandling.kt`), plus 23 id-path operations missing their (real) 400 responses in the spec.


**E2E scenarios (design artifacts).** The Playwright suite in `e2e/` is governed by `e2e/README.md` (run recipes, the parallel state-ownership rulebook, the coverage map). Since v2.19.0 every spec has a **natural-language scenario file** in `e2e/scenarios/` — versioned, deliberately non-executable design artifacts (actors, owned state, numbered user-level steps, expected outcomes; `## Scenario:` headings equal the `test()` titles verbatim). `e2e/scenarios/README.md` holds the format and the **compiler contract** — the house rules any human/agent/tool must satisfy when turning a scenario into spec code. Same-commit rule: a new or behaviorally changed test lands with its scenario file and its one-line entry in the e2e README's coverage map.
