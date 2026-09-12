# WP-10: event-derived progress, decisions and outcome metrics

## Delivery boundary

`contracts/work-progress.mjs` under the packaged Codex integration exports
`projectWorkProgress(scope, log)`. It is a pure, read-only view-model builder: no
network calls, clock reads, filesystem writes, database, HTTP endpoint, merge,
release or deployment. Existing controller commands/exports and Worker Handoff v1
are unchanged. The module is imported by its trusted installed filesystem path,
like the other host-integration contracts, not through a new package export.

This completes the public reporting contract and tests, **not production UI
activation**. The private UI/event store is not present in this repository. Do not
wire the static challenge edition and call it the production application. The
host must supply authenticated, tenant-authorized durable events and wire the view
model into the real UI. Those activation and evidence tasks remain open in #34.

## Host contract

The trusted `scope` has exactly `tenantId`, `goalId`, `asOfMs`, `costUnit`, and
`defectWindowMs`. Times and cost units are nonnegative safe integers;
`defectWindowMs` is positive. Choose the cost unit and defect observation window
explicitly as reporting policy; the module does not invent a monetary currency,
cost conversion, service objective or production traffic baseline.

The log has exactly `schemaVersion: 1`, `complete: true`, `lastSequence`, and
`events`. The service must read a consistent per-goal log from sequence one through
the supplied watermark, complete as of the server's `asOfMs`. Partial pagination,
unknown event types, missing sequence numbers, backwards durable timestamps,
future events, foreign-tenant/goal records and conflicting event IDs refuse the
whole projection. Identical event replay is deduplicated without changing counts
or the log digest. Sequence order is required; input is never silently sorted.

The complete log is bounded to 256 input events and 64 assignments, in addition to
the shared 256 KiB / 10,000-node inert-data limits. Oversized histories **refuse**;
they do not truncate or return a falsely complete result. Larger installations
need a separately reviewed durable checkpoint/aggregation protocol before using
this contract. No checkpoint parser or permissive incomplete-history fallback is
provided here. The log, reporting policy, identities and digests are data contracts,
not signatures or authorization. A forged `complete: true` is not trusted evidence.

Before calling the projector the host must authenticate the session, recheck read
permission and tenant membership, authorize this exact goal, retrieve all scoped
events, validate provider evidence and consistently bind the watermark/time. Never
accept any of those as worker JSON, route-request claims or agent summaries. The
projector is NOT the server authorization boundary. Do not use its stage machine
as a replacement for the existing acceptance or delivery enforcement.

## Durable event envelope

Each event has exactly:

```js
{
  id: 'durable-event-id', sequence: 1,
  tenantId: 'tenant-id', goalId: 'goal-id', assignmentId: 'assignment-id',
  actorId: 'authenticated-actor-reference', atMs: 1000,
  type: 'work-started',
  data: { revision: {
    repository: 'owner/repo', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40)
  } }
}
```

The repeated characters and small timestamp above are illustrative only. Real
records use actual provider revisions and server-generated durable timestamps.
`assignmentId: null` is reserved for explicit parent-goal decisions. Revision
objects always have exactly `repository`, `baseOid`, `headOid`; SHA-1 commit OIDs
and SHA-256 evidence digests are lowercase and full length. Event IDs remain stable
on retry; a different ID is a different event and cannot repeat a one-shot effect.

### Event payloads (exact keys)

`revision` below means the exact current tuple. `evidenceSha256` identifies the
provider/store evidence, not prose. Validate and retain the referenced evidence in
the authoritative service; hashing arbitrary worker text does not establish truth.

| Event | `data` keys / interpretation |
| --- | --- |
| `work-started` | `revision`; creates one running assignment. |
| `revision-changed` | `revision`; before merge only, same repository, changed head or base. Clears current submission/review/acceptance/PR/merge authorization/cost. Retains historical review identity for display, never as current authority. Use a new assignment after merge. |
| `evidence-submitted` | `revision`, `submissionId`, `evidenceSha256`; from running or rework. |
| `review-recorded` | `revision`, `submissionId`, `reviewId`, `evidenceSha256`; records review of the current submission. It is not itself acceptance or merge approval. |
| `rework-requested` | `revision`, `submissionId`, `reasonCode`; returns the assignment to rework. |
| `evidence-accepted` | `revision`, `submissionId`, `reviewId`, `acceptanceId`, `evidenceSha256`; must match the observed submission and review. Normalize the host's authoritative acceptance receipt, not the worker's claim. |
| `draft-created` | `revision`, `prNumber`; after acceptance. |
| `merge-authorized` | `revision`, `prNumber`, `authorizationId`; an explicit observed owner decision. |
| `merged` | `revision`, `prNumber`, `authorizationId`, `mergeOid`; actual merged commit, which may differ from the reviewed head after squash/rebase. |
| `deployed` | `deploymentId`, `sourceOid`, `artifactSha256`, `environment`; source must equal the observed merge commit. Environment is `staging` or `production`. New deployment IDs cannot be reused. |
| `post-deployment-verified`, `deployment-health-failed`, `deployment-ended` | The same four deployment fields plus `evidenceSha256`; match the active deployment in that environment. Failure/end clears verified state. |
| `blocker-raised` | `blockerId`, `code`, `ownerRole`, `decision`; explicit unresolved reason and required action. |
| `blocker-cleared` | `blockerId`; clears only that existing blocker. |
| `lifecycle-interrupted`, `lifecycle-recovered` | `interruptionId`, `evidenceSha256`; recovery must match an open interruption and does not advance work state. |
| `manual-override-recorded` | `overrideId`, `reasonCode`, `evidenceSha256`; counted separately, never grants acceptance, merge, deployment or goal completion. |
| `execution-cost-finalized` | `acceptanceId`, `units`, `unit`, `evidenceSha256`; one reconciled execution cost through the exact current acceptance. Unit must match policy. |
| `defect-recorded` | `deploymentId`, `defectId`, `detectedAtMs`, `evidenceSha256`; post-verification defect, including late-recorded detection. |
| `defect-window-closed` | `deploymentId`, `throughMs`, `evidenceSha256`; explicit complete observation through first verification time plus the policy window. The window cannot be shortened or closed early. |
| `goal-confirmed` | Parent only: `outcome` (`code-delivery` or `production`), `evidenceSha256`; explicit coordinator decision. All children must be merged, without blockers/interruption; production additionally requires active verified production deployments. |
| `goal-reopened` | Parent only: `reasonCode`; clears the explicit goal decision. |

Reason/code values: `evidence-invalid`, `required-checks`, `unavailable-provider`,
`external-integration`, `release-approval`, `recovery-needed`, `scope-changed`.
Roles: `worker`, `reviewer`, `coordinator`, `owner`, `operator`.
Decisions: `submit-evidence`, `review-revision`, `accept-or-rework`,
`revise-and-resubmit`, `create-draft`, `authorize-merge`, `merge-reviewed-revision`,
`deploy-artifact`, `verify-deployment`, `recover-lifecycle`, `supply-integration`,
`resolve-checks`, `confirm-goal`. Map roles to authorized named people in the host.
The view model does not guess personal identities or issue credentials.

## UI rendering rules

Display `asOfMs`, `lastSequence` and `logSha256` with the snapshot. Each assignment
carries its exact current revision, last reviewed revision, current review and
acceptance IDs/times, PR and merge identities, last event ID/type, active deployment
records, unresolved blockers and required owner-role/decision pairs. Resolve IDs
through authorized provider routes. Use escaped text / `textContent`, never HTML
insertion or link construction from arbitrary IDs or revision text.

Show running, submitted, rework, accepted, draft created, merge authorized, merged,
deployed and post-deployment verified as distinct labels. A review received is not
acceptance. A green check is not a merge decision. A merged child is not a deployed
product. Active deployments are tracked separately by environment; later staging
activity cannot overwrite active production facts. The primary deployment display
prefers production, then staging. A replacement never inherits health verification.

No child event automatically completes a goal. `pendingGoalActions` requests an
explicit coordinator decision once delivery prerequisites are present. A confirmed
code-delivery goal can still have `productionVerified: false`. New scope, revision,
blocker, interruption or deployment changes invalidate prior goal confirmation;
clearing a blocker does not restore it automatically. Parent confirmation remains
an explicit durable event after revalidation.

`productionVerified` means the supplied complete log records a currently active
production deployment with post-deployment verification, **as of the snapshot**.
It is not continuous health monitoring or a freshness SLA. Display deployment and
last-verification timestamps; an old snapshot must not be presented as a live probe.
For rollback/teardown, record the affected deployment's end/failure and the actual
restored deployment under its own delivered assignment. Never claim that reverting
source code reverses a database migration or proves successful recovery.

## Metrics and denominators

All metrics cover this complete goal history through `asOfMs`, not a selected
success-only page, cross-goal portfolio or invented rolling window. Durations use
durable recorded times, not agent-reported start/finish prose. Median uses the
usual middle/mean-of-two definition; p90 uses nearest rank. Missing/zero-denominator
ratios and empty duration samples return `null`, not fabricated zero success/failure.

- **Accepted-outcome lead time:** start to first accepted event per assignment;
  report median/p90, sample count and never-accepted pending count. First-pass
  acceptance is one submission at that first acceptance, divided by assignments
  ever accepted. Later invalidation does not erase that historical cohort.
- **Review waiting time:** submission to first recorded review (or a rework decision
  without a separate review record). Open waits and revision-abandoned waits are
  reported separately, not included as zero-duration samples.
- **Accepted outcomes per execution cost unit:** currently accepted assignments /
  reconciled execution units through their current acceptance. With any assignment
  lacking finalized cost, the result is unknown; pending work is not treated as
  free. This is execution-to-acceptance efficiency, NOT whole production spend,
  billing, model-price estimation or profitability. Revision change invalidates cost.
- **Escaped-defect rate:** distinct verified production deployments with at least
  one detected defect in `[firstVerifiedAtMs, firstVerifiedAtMs + windowMs)` /
  deployments with explicitly closed observation windows. An overall value is
  unknown while any verified production window is still open. Late-reported
  detections update the correct window. Staging is excluded.
- **Successful recoveries:** recovered distinct interruption IDs / all distinct
  interruptions, retaining unresolved cases in the denominator. Manual override
  count is independent and never promotes a stage or supplies missing evidence.

## Activation acceptance remains external

The real UI must pass tenant/revocation read-denial tests, contiguous snapshot and
pagination tests, event provenance/retention checks, and counter reconciliation
against its real durable store. Exercise stale head/base, duplicate replay,
child-vs-parent completion, production-vs-staging, health loss/rollback, missing cost
and late defects in that UI. Define how named owners, live refresh and health
freshness are displayed. None of the synthetic unit fixtures proves that wiring,
private-service enforcement, production telemetry or deployment happened.

Local focused command: `node --test test/work-progress.test.mjs`. The standard
repository `npm run check` automatically includes it; the installed-package
inventory also checks packaged contract/document bytes. No workflow, dependency,
package version, publication policy or production setting changes are needed.
