# Audit status

Updated 2026-09-06 against `098abb2`. This consolidates the deployment audit of
`db9fbbf` and application audit of `4359f46`, including the completed follow-up work.
Use the linked feature documentation and runbooks for current behavior and procedures.

## Completed

| Area | Current status | Evidence and maintained guidance |
| --- | --- | --- |
| Session isolation | Session boundaries clear caller state; stale asynchronous responses and cross-tab changes are guarded. | [PR #12](https://github.com/liveweird/lettuce/pull/12), [frontend conventions](../../web/CLAUDE.md#session-isolation) |
| Authentication | MFA challenge transitions are atomic; unknown-account password checks perform equivalent-cost bcrypt verification. | [PR #12](https://github.com/liveweird/lettuce/pull/12), [security](security.md) |
| Quality gates | Backend, Web, API contract, and E2E source checks run automatically and are required on up-to-date PRs to `master`. Existing merge protections remain, with no bypass actors. | [PR #13](https://github.com/liveweird/lettuce/pull/13), [testing](testing.md) |
| Deployment configuration | Java build/runtime targets align on 21; Compose ports are loopback-bound; health/readiness/startup probes and separate deployment templates are present. | [deployment runbook](../skills/run-stack/SKILL.md), [security](security.md) |
| Image identity | Kubernetes app deployments require an explicit published image digest; routine infrastructure applies exclude the app Deployment. Build and supporting images are pinned to verified multi-platform digests. | [PR #14](https://github.com/liveweird/lettuce/pull/14), [PR #15](https://github.com/liveweird/lettuce/pull/15), [container images](container-images.md) |
| Dependency integrity | Gradle project/settings locks and SHA-256 artifact/metadata verification are enforced; the wrapper distribution has its own checksum. Docker and CI consume the committed state. | [PR #16](https://github.com/liveweird/lettuce/pull/16), [dependency reproducibility](dependency-reproducibility.md) |
| Build identification | Git refs for `build/*` branches survive Docker context filtering; missing source metadata fails the build. A Docker-context regression covers the original failure. | [PR #16](https://github.com/liveweird/lettuce/pull/16), [testing](testing.md) |
| Recovery rehearsal | An isolated PostgreSQL restore matched archived data, migrations, sequences, roles/settings, and logical schema. Encryption bootstrap and readiness passed with the required keys. Temporary resources were removed. | [PR #14](https://github.com/liveweird/lettuce/pull/14), [backup and restore](backup-and-restore.md) |

## Accepted decision

HR retain their existing auditor read access, including succession plans where the
HR identity overlaps a subject or nominated candidate. Their non-participation in
processes is an organizational assumption, not a new runtime restriction. This
finding is accepted, not an outstanding authorization fix. Existing owner/management
grants are unchanged; other role-overlap questions were not decided by this exception.
See [authorization](authorization.md) and [succession plans](features/succession-plans.md).

## Parked by the user

The following production topics are deferred, with no implementation scheduled:

- Production registry, release-image publication/promotion, and deployment target.
- Migration of the reference ingress to a maintained controller, with verification
  of TLS, redirects, trusted proxy headers, and routing behavior.
- Scheduled off-host backups, retention, independent encryption-key recovery,
  point-in-time recovery, and measured recovery-time/data-loss objectives.

No production registry, replacement controller, production Compose configuration,
or Kubernetes overlay tool has been selected. Earlier design suggestions are not
requirements or decisions to implement automatically.

## Verification and limits

The completed changes passed the four required hosted checks. Local verification
included 1,103 backend tests, frontend tests and coverage, fresh-cache dependency
resolution, negative lock/checksum checks, Linux ARM64 container packaging, browser
session-race checks, and sign-in/dashboard/logout smoke checks. The final local
application built from `a615d1d` displayed that source stamp and passed health/readiness
checks; the existing database volume and supporting service images were preserved.

This evidence does not establish production readiness. In particular:

- The restore demonstrated the development logical-restore path, not production
  disaster recovery, off-host retention, independent key recovery, or PITR.
  Recovery requires the database archive and separately retained keys needed to
  decrypt it, including any required fallback keys; key-escrow retrieval was not tested.
- Compose remains a development demo with committed demo credentials, Mailpit,
  and integration access enabled. It is not a production configuration.
- No production image publication or Kubernetes rollout was performed in this
  follow-up. Full automated deployment journeys through both deployment paths,
  representative visual/accessibility review, load testing, exhaustive penetration
  testing, and long-term flake analysis remain unverified by these audits.
- Multi-instance deployment remains unverified. Instance-local authentication state
  and rate limits need an explicit design review before scaling. Rolling-deployment
  overlap on the existing single-replica deployment is addressed: `k8s/templates/app-deployment.yaml`
  sets `strategy: type: Recreate`, so the old pod is torn down before the new one starts —
  two pods never briefly share (and split) in-memory session/rate-limit state.
- Container/dependency pins do not prove byte-for-byte reproducibility or publisher
  authenticity. Remaining package/toolchain inputs and checksum trust are documented
  in the linked image and dependency runbooks; reviewed updates remain necessary.
- Registered API gaps and accepted persistence/concurrency tradeoffs remain documented
  exceptions in the [API guidelines](../../api-guidelines/API-GUIDELINES.md) and
  [persistence guidance](persistence.md), rather than newly discovered defects.

Update this status when a parked topic is resumed or new verification changes these
limits. Broad refactors and deployment-tool choices are not an audit requirement.
