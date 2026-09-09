# `projects-pr` v2 controller

`projects-pr` turns one reviewed, low-energy Projects worker handoff into one
verified draft pull request. The v2 lifecycle is deliberately split so a
harness-native side-chat worker can receive the exact prepared worktree:

`doctor → delegate_pack → prepare → spawn side-chat task → bind_delegation_thread → worker → review → finalize`

The controller does not delegate or run the worker, submit or review Worker
Handoff v1, complete a parent pack, auto-merge, close a pull request, or deploy.
The coordinator owns those Projects boundaries. `finalize` and `stack` remain
draft-only; the separate delivery path described below requires a trusted
repository policy plus new exact-head review and owner confirmations.
After the harness creates the side-chat task or thread, the coordinator binds
the returned child `packId` to its provider-neutral thread ID and, when
available, its absolute HTTPS URL before the worker submits its terminal
handoff. That immutable binding makes the child conversation visible and
resumable without copying its transcript, credentials, tokens, or
provider-specific payload into Projects. Rework continues in the same child
pack, worktree, and bound side chat; it does not create a replacement.

## Commands

```text
projects-pr doctor [--repo PATH] [--base BRANCH] [--remote NAME] [--stack]
projects-pr prepare --pack-id ID --title TEXT --base BRANCH \
  --verify-command COMMAND [--repo PATH] [--remote NAME]
projects-pr status --pack-id ID [--repo PATH]
projects-pr finalize --pack-id ID [--repo PATH]
projects-pr authorize --pack-id ID --reviewed-head SHA \
  --confirm-review --confirm-owner [--repo PATH]
projects-pr authorize-admin --pack-id ID --reviewed-head SHA \
  --confirm-review --confirm-owner --reason TEXT \
  --bypass REQUIREMENT [--bypass REQUIREMENT ...] [--repo PATH]
projects-pr finish --pack-id ID [--repo PATH]
projects-pr abort --pack-id ID [--repo PATH]
projects-pr stack --pack-id BOTTOM --pack-id NEXT [--pack-id TOP ...] \
  --base BRANCH [--repo PATH] [--remote NAME]
```

There is no `--execute`, `--work-command`, compatibility alias, or PATH-based
fallback in v2.

## Safety contract

| Boundary | Fixed behavior |
| --- | --- |
| Worker capacity | Exactly one harness-native worker |
| Energy | Low |
| Pull request state | `finalize` and `stack` are draft only |
| State location | `<absolute-git-common-dir>/projects-pr-v2/<packId>.json` |
| Verification | One command fixed and hashed at `prepare` |
| Push scope | `HEAD:refs/heads/<derived-branch>` only |
| Repository binding | Exact GitHub host and owner/repository from the declared remote |
| Base binding | Checked-out local base commit must equal the declared remote base commit |
| Success cleanup | Remove only the exact clean prepared worktree |
| Failure cleanup | Preserve the worktree and local branch for diagnosis |
| Merge authority | Manual unless trusted policy and a fresh, separate authorization opt in one exact PR |

`doctor` requires no pack ID or title and is fully read-only. It checks Node
22+, Git, PowerShell 7 on Windows or `/bin/sh` on Unix, the exact clean Git top
level and checked-out base, equality between the local and remote base commit,
Git common directory, a credential-free GitHub HTTPS/SSH remote, remote access,
GitHub CLI authentication for the derived host, and exact repository identity
with explicit GitHub push permission. It returns `status: "ready"` or
`status: "unavailable"`; unavailable capability must stop the workflow before
`delegate_pack`.

`prepare` repeats `doctor`, refuses existing state, local/remote branches, or an
occupied worktree, records the base commit and fixed verification-command hash,
and creates one sibling worktree. Its JSON receipt exposes the absolute
`plan.worktreePath` that the coordinator gives to the assigned side-chat
worker. The worker must commit at least one change and leave that worktree
clean.

`status` reads the versioned state and observes the exact local branch,
worktree, remote ref, and GitHub PR set. It performs no mutation.

`finalize` repeats all capability checks, requires the exact clean prepared
branch to descend from the recorded base, runs the stored verification command
with PowerShell 7 or `/bin/sh -c`, and rejects any verification that changes
the worktree or HEAD. It pushes only the derived ref, verifies the remote ref at
the tested commit, creates one draft PR with explicit `--repo`, then reads that
PR back through the exact repository API and verifies its URL repository,
base/head repository identities, draft/open state, base/head refs, and nonempty
exact head commit before removing the exact worktree. The local and remote
branches remain.

Finalization is resumable. An exact pre-existing remote ref or matching open
draft is reused; any mismatched ref, non-draft PR, wrong base/head, wrong commit,
duplicate PR, or inaccessible remote state fails loudly. A completed state is
idempotent and returns its already-verified draft receipt.

## Optional reviewed delivery (unreleased source)

The tagged beta package remains draft-only. The current source adds three
separate commands; none is called by `finalize`, `stack`, or the default skill
flow:

1. `authorize` requires `--reviewed-head`, `--confirm-review`, and
   `--confirm-owner`. It freshly verifies the finalized open draft and binds the
   exact GitHub host/repository, PR number and URL, base ref and SHA, derived
   head ref and reviewed SHA, and trusted policy digest.
2. `finish` consumes only that stored authorization. It does one bounded
   observation pass and returns `waiting` with the exact resume command when a
   configured check is not successful. Immediately before each external
   mutation it rechecks exact identity and head. It makes the draft ready,
   observes checks again, requires GitHub to report ordinary merge state
   `clean`, then calls the synchronous one-PR merge endpoint with the authorized
   head SHA. It never uses native auto-merge, a merge queue, or the asynchronous
   stacked-merge endpoint.
3. `authorize-admin` is disjoint from normal authorization. It additionally
   requires a nonempty reason and repeated `--bypass` values that exactly equal
   the freshly observable supported GitHub ruleset requirements. The only
   supported values are `github-ruleset:pull-request`,
   `github-ruleset:merge-queue`, and `github-ruleset:update`. Classic branch
   protection, repository-required status checks, unknown rules, inaccessible
   observations, and configurations needing no bypass are refused. A later
   normal merge failure never enables this path.

Classic protection is observed separately through the exact GraphQL
`Ref.branchProtectionRule` with administrator viewer permission and a matching
base ref. The REST branch `protected` flag is retained only as aggregate
evidence because GitHub defines it over classic protection or rulesets; it is
never treated as proof that classic protection is absent.

The admin reason is persisted in local state and appears in receipts. Do not
put credentials, tokens, personal data, or other secrets in it.

All delivery settings are off when `.github/projects-pr-policy.json` is absent
at the exact PR base SHA. Policy is fetched from that immutable GitHub object,
never from the PR checkout or head. A present file is strict: malformed JSON,
unknown fields, duplicate identities, or repository mismatch fails loudly.

```json
{
  "schemaVersion": 1,
  "repository": "github.com/OWNER/REPOSITORY",
  "reviewedMerge": {
    "enabled": true,
    "method": "squash",
    "requiredChecks": [
      { "kind": "check-run", "name": "test", "publisherId": 15368 }
    ]
  },
  "remoteBranchCleanup": {
    "enabled": false,
    "protectedBranches": ["release"]
  },
  "adminOverride": { "enabled": false }
}
```

`kind` is `check-run` or `status-context`; `publisherId` is respectively the
GitHub App ID or status creator ID. Only one exact publisher/name observation
may match. A check run passes only with `status: completed` and
`conclusion: success`; a status context passes only with `state: success`.
Missing, pending, failed, skipped, neutral, cancelled, stale-SHA, ambiguous,
unknown, incomplete, or API-error observations never merge. New commits do not
follow the branch: they invalidate the review and authorization.

Coordinator review/owner confirmations are attestations supplied to the local
controller. They are not independent GitHub review approvals, do not replace
branch protection, and cannot constrain merges performed outside this tool.
The exact-head merge guard is atomic for the PR head, not the base branch;
external base updates remain a documented concurrency boundary.

After a verified merge, optional cleanup considers only the controller-derived
remote branch at the reviewed SHA. It retains default, policy-protected,
shared, stack-base, and dependent-PR branches. It requires exactly one
credential-free, non-mirror push URL with no custom port and exact repository
identity, then uses
`git push --force-with-lease=refs/heads/BRANCH:REVIEWED_SHA REMOTE :refs/heads/BRANCH`.
The explicit ref-value lease rejects a different ref value at deletion time.
It cannot distinguish delete-and-recreate-at-the-same-SHA history entirely
between observations; terminal recorded absence/recreation is guarded
separately. Default/dependency observations are not transactionally locked.
Already absent, deleted by this controller, waiting, and policy-retained are
distinct receipts. A terminal absent/deleted receipt never deletes a later
recreated ref. Local branches, worktrees, state, and evidence are always kept.

`github.com/wornpage/projects-webmcp-extension` is a built-in frozen delivery
target. Neither normal nor admin authorization can override that boundary.

`abort` is intentionally narrow. It removes only an unpushed, PR-free,
unchanged prepared worktree whose branch is still at the recorded base commit.
Worker commits, dirty files, remote state, inconclusive observations, or a
completed lifecycle cause refusal. It never uses force deletion.

## Optional draft stacks

`doctor --stack` additionally requires the installed GitHub CLI extension list
to identify exactly `gh stack` from `github/gh-stack`, and verifies that its
non-interactive `gh stack link` command is available. It never installs or
updates the extension.

`stack` accepts two or more unique completed pack IDs in exact bottom-to-top
order. Every layer must still have passed the ordinary one-worker lifecycle and
must identify one open draft at its recorded tested commit. The controller then
invokes only the official stack-link command without `--open` and verifies the
resulting chained bases through the exact repository API.

GitHub stack linking is not atomic. A failed operation may have changed some PR
bases. The failure receipt preserves the exact ordered recovery command; inspect
the remote state and repeat that same command rather than changing the order or
layer set.

## State and receipts

The private state file uses schema version 1. It stores repository and GitHub
identity, derived branch/worktree, base commit, the fixed verification command
and its SHA-256, lifecycle phase, tested/pushed commits, and verified draft PR.
It has no dedicated bearer-token field and contains no captured command output.
Because the exact verification command is stored verbatim, never place a
password, token, credential-bearing URL, or other secret in that command.

Every public receipt uses schema version 2 with:

- `command` and `status` for the lifecycle operation and outcome.
- `constraints` with explicit low energy, one-worker capacity, and draft-only
  authority.
- `repository` with root, base, remote, and exact GitHub identity.
- `plan` with the branch, exact worktree, and verification-command SHA-256;
  the raw verification command is not repeated in receipts.
- `state` with its exact path, schema version, and lifecycle phase.
- `result` with observed state, exact pushed refspec, verified draft identity,
  cleanup facts, or verification exit status where applicable.
- `error` with a bounded code, message, and process exit code, never stdout or
  stderr.
- `recovery` with one bounded next command and closed argument array for
  `doctor`, `status`, `finalize`, `abort`, or `stack`.

Successful finalization records an `ownerDecision` that links the draft PR and
tested command hash while retaining
`merge.ownerControlled: true`, `autoMerge: false`, and
`status: "not_requested"`.

Delivery authorization is nested separately under state `delivery`; it does
not change the completed draft lifecycle phase. Delivery receipts use kind
`projects-pr-delivery`, record authorization mode, exact identity and policy
binding, check observations, merged head and merge commit, and cleanup outcome.
If GitHub merged the exact authorized PR but local state persistence failed,
`finish` verifies that already-merged identity and records it without issuing a
second merge request.

The public library entry point is `@wornpage/projects-pr`. Its runner and
filesystem are injectable; focused tests replace remote GitHub and controller
mutation effects. A disposable local bare-Git fixture proves exact-value lease
failure without touching a hosted repository. Tests create no GitHub branch,
worktree, push, merge, or pull request.

## Beta limitations

Run only one controller process per repository. Cross-process state locking is
not implemented, and existing draft-lifecycle child processes do not yet have
controller-enforced timeouts. Delivery effects use a 30-second per-process
bound and a one-shot resume receipt instead of a daemon or indefinite watch.
These are explicit beta limits, not silent recovery paths.
