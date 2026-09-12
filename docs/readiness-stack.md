# Readiness stack: acceptance, review, hosted rehearsal, and client transitions

This increment supplies four ordered implementation layers in one PR. It does
**not** activate the private Projects service, certify its database/authorization,
publish a package, change installed clients, alter branch protection, or deploy.
The private service source and a disposable hosted target were not exposed to the
implementation session. Those deployment dependencies are not replaced by mocks.

## 1. Hosted acceptance integration (WP-08a)

`integrations/codex/projects-pack-delegation/contracts/hosted-code-acceptance.mjs`
exports `createHostedCodeAcceptance(adapters, policy)`. There is deliberately no
HTTP listener, default database, default validator, default identity, or permissive
fallback. Import the module from trusted installed source, not a worker checkout.
The returned function accepts a **server-authenticated** principal record and a
separate untrusted request. Never construct the principal or policy from that request.

Principal fields are `tenantId`, `actorId`, and `sessionId` (an opaque session
reference, not a bearer token). Request fields are `assignmentId`,
`expectedVersion`, `idempotencyKey`, and `handoff`. Only inert bounded JSON data is
accepted; input and policy references are captured before asynchronous work.
Unknown request/principal fields are refused.

The authoritative assignment has `id`, `tenantId`, `kind: code`,
`status: submitted`, `version`, `packId`, `workerId`, `workerActorId`,
`workerGitHubIds`, `repository`, `baseOid`, `headOid`, `contextSha256`, and
`verificationCommand`. Additional trusted scope/purpose fields are retained in its
whole-record digest. The host must keep identity mappings and assignment fields
worker-immutable. GitHub.com same-repository SHA-1 revisions are the supported
provider format here; other providers/object formats need a reviewed extension.

### Required adapter contracts

| Adapter | Mandatory behavior |
| --- | --- |
| `store.transaction(scope, callback)` | Scope by tenant **and** assignment; serialize acceptance or implement equivalent transactional CAS. Resolve only after commit. Do not independently retry external mutations. |
| `tx.authorize(principal, 'accept-code')` | Check the current authenticated session, revocation, tenant membership and acceptance role. Return exact `true` only when authorized. Rechecks must participate in the transaction's authorization consistency policy. |
| `tx.getAssignment()` | Return the authoritative, scoped assignment, never a request-supplied substitute. |
| `tx.getIdempotency(actorId, key)` | Return `null` or the atomically persisted record, scoped by tenant/assignment/actor/key. Enforce a unique index; do not return another tenant's record. |
| `tx.commitAcceptance(record)` | Atomically compare `expectedVersion`, mark accepted/increment version, and persist `receipt`, `event`, and the entire `idempotency` record. Return exact `true` for a durable success, false for a known conflict; do not partially commit. |
| `validateHandoff(schema, handoff)` | Use a real Draft 2020-12 validator on the generated assignment-bound schema. No coercion, defaults, property removal, or remote reference retrieval. Return exact boolean. |
| `readReview(assignment)` | Obtain trusted, independent evidence bound to repository/base/head/context. Require `status: validated`, `reportValidated: true`, `reportSha256`, and numeric `reviewerIds`. Do not copy those flags out of worker JSON. |
| `readVerification(assignment)` | Obtain trusted runner evidence with exact repository/base/head, `passed: true`, `runnerId`, `artifactSha256` and literal `commandSha256`. Retrieve/check the artifact through the trusted runner store. Worker-reported success alone is insufficient. |
| `observeRevision(assignment)` | Freshly observe exact repository/base/head/context, refusing unreadable, dirty, stale, or truncated evidence. |

Policy requires nonempty unique `reviewerIds` and `runnerIds`. A policy-listed
reviewer still cannot be the assignment worker. The acceptor cannot be the worker.
The existing handoff builder enforces the exact assignment/command. Native report
validation remains necessary; GitHub approval by itself does not inspect a handoff.

All observations must complete before acceptance. Authorization is rechecked after
observations and on replay. CAS, uniqueness, outcome and audit writes belong to the
**same** database transaction. A lost commit response returns
`acceptance_outcome_unknown`, not proof of failure; retry the same key and exact
request after observation. A changed request with the same key conflicts. Replays
can use a renewed authorized session but cannot bypass revocation. Receipts and
events contain digests and identity/revision metadata, not raw commands, report
prose, session references or tokens.

The in-memory test adapter proves orchestration/denial/idempotency behavior only.
It is not a production persistence implementation. The semantic CI job independently
runs the existing handoff schemas with a real validator; the new Node adapter tests
do not pretend their stub is a standards-compliant validator. Before deployment,
run the same cases against the actual service validator, identity provider and DB,
including cross-tenant IDs, revocation, simultaneous writes, transaction rollback,
post-commit connection loss, audit retention and backup restore. Supply bounded
adapter deadlines and transaction cancellation in that service.

GitHub and a service database do not share a transaction. The observed immutable
revision is recorded; this does not freeze a moving branch after observation or
authorize merging/deployment. Revalidate delivery independently.

## 2. Independent GitHub review evidence (WP-03c)

`github-review-evidence.mjs` reads authenticated REST reviews and GraphQL review
threads through `github-read-client.mjs`. The client permits only a fixed HTTPS
GitHub host, PR/review GET routes, and one fixed read-only GraphQL query. Redirects,
mutation routes, retry loops, oversized/invalid responses, and missing credentials
are refused. Each request has a ten-second deadline and 1 MiB response cap.

The operator supplies trusted repository/PR/base/head, numeric `reviewerIds`,
`excludedIds` for workers and other non-independent identities, and
`minimumApprovals`. The PR author is always excluded. The latest **submitted**
decisive review per user governs; a comment does not erase a request for changes.
An allowlisted approval must match the exact head. Dismissed, pending, stale,
comment-only or self reviews do not count. Outstanding changes requests and any
unresolved thread refuse. Pagination is bounded and must complete; PR head/base
reads bracket the collection. The collector returns validation evidence, not merge
permission, signatures, or proof that every human reasoning step was sound.

Run `node scripts/check-independent-review.mjs /trusted/review-policy.json` with a
read-only `GH_TOKEN`. The JSON keys are `repository`, `number`, `baseOid`, `headOid`,
`reviewerIds`, `excludedIds`, `minimumApprovals`. Do not put credentials in the
file, source it from PR HEAD, or treat a contributor-edited allowlist as policy.
This is an explicit checker, not a newly configured required repository check.

A review model must actually be invoked separately. An independent review request
is not a completed review. Comment-only automated feedback is advisory and is not
converted into an approval by this checker. The implementation PR separately
requests provider review; actual findings and coverage must be inspected at its
final head. See GitHub's official [review API](https://docs.github.com/en/rest/pulls/reviews)
and [Copilot review instructions](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review).

## 3. Authenticated hosted draft rehearsal (WP-07d)

`Hosted draft rehearsal` is manual-only, default-branch-only and attached to the
`projects-pr-hosted-rehearsal` environment. The checked-in policy is **disabled**.
No PR, push, schedule or workflow-run event starts this credentialed operation.
A disabled or incomplete policy fails; it never prints a simulated hosted success.

Before explicitly dispatching, the owner must provide a dedicated repository whose
name starts `projects-pr-rehearsal`, record its exact numeric ID and initial `main`
commit in `.github/hosted-rehearsal.json`, and commit this marker in that baseline:
`{"kind":"projects-pr-disposable-rehearsal","repositoryId":123}` (replace 123 with
the actual ID). Enable only through reviewed policy. Configure environment-required
reviewers and deployment-branch restrictions in GitHub; **naming an environment in
YAML does not itself configure those protections**. Set the environment secret
`PROJECTS_PR_REHEARSAL_TOKEN` to a short-lived credential restricted to that test
repository with contents and pull-request write access. Never supply a production
credential. No such repository, credential or environment protection was created
by this change. See [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Dispatch requires the exact configured repository as confirmation. The script
checks numeric identity, non-fork/non-archived status, default branch, push access,
pinned base and marker before preparation. It packs and installs the exact source
artifact offline with npm hooks disabled and without forwarding the credential to
npm. It verifies installed inventory/bytes and invokes the installed CLI without
controller dependency injection. Only the known rehearsal file is executed; its
actual verification head is recorded outside the worktree.

The live scenario covers doctor, prepare, a real worker commit, verification,
draft creation, status and completed-finalize replay, requiring one exact draft,
one verification execution and unchanged remote `main`. It requests **no merge,
admin override, remote deletion or cleanup**. Draft/branch and bounded recovery
summaries are retained. The upload step uploads only selected JSON, never HOME,
credentials, raw subprocess output or Git directories. Artifacts expire after
seven days. Interrupted runs require operator reconciliation, not blind reruns.
This is a happy-path/replay hosted scenario, not live network-fault injection,
automatic independent review, or all negative hosted authorization cases. Existing
local negative suites remain distinct evidence.

## 4. Installed client transitions (WP-09a)

`Client transition` is a separate read-only PR/push CI workflow. It runs on Linux
and Windows Node 22/24 plus macOS Node 24. Both checkouts disable persisted
credentials. The released-source baseline is the peeled `v2.5.0-beta.3` tag commit
`101c870e3f80b504a91b45881831e5b906896d2e`, pinned in both workflow and script.
This is a locally rebuilt historical source artifact, **not** an npm-registry
artifact or signed release attestation.

From complete clean checkouts, run `npm run check:transition -- ../baseline`.
The contract packs baseline and candidate once, verifies archive digests, and
installs baseline -> candidate -> the original baseline tarball into the same
disposable consumer. Every stage checks exact inventory and all file bytes,
permitting only the existing CLI shebang exception. Baseline/candidate can have
the same unreleased version label: artifact hashes, not version strings, identify
the different builds. A new version still needs an owner-authorized release.

The actual installed baseline prepares legacy state using the strict local-Git
fixture. Because that release predates locking, **only that fixture preparation**
is wrapped in the current external lock; this does not pretend the old binary has
new protections. Subsequent installed status probes use fresh Node processes so
module caches cannot mask the installation change. They require byte-identical
saved state through upgrade/rollback. GitHub responses are simulated. The candidate
refuses a lock-preserving mutation, and rollback is refused while test lock evidence
exists, before npm runs. Only the test-owned sentinel is removed for the controlled
rollback; production lock removal is never automatic.

This proves installed-file transition and a legacy prepared-state read path, not
all historical states, database migrations, deployed-service rollback, or old-client
safety. Old clients do not honor the new locks. Production rollback requires
stopping writers, reconciling live local/remote effects, archiving evidence and
confirming compatibility; a package swap is not a database rollback. Run staging
health, migration, backup/restore and rollback tests in the private deployment
before authorizing a production release. None of those outcomes is inferred from
these local or hosted-runner tests.
