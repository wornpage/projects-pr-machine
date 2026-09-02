# `projects-pr` v2 controller

`projects-pr` turns one reviewed, low-energy Projects worker handoff into one
verified draft pull request. The v2 lifecycle is deliberately split so a
harness-native side-chat worker can receive the exact prepared worktree:

`doctor → delegate_pack → prepare → spawn side-chat task → bind_delegation_thread → worker → review → finalize`

The controller does not delegate or run the worker, submit or review Worker
Handoff v1, complete a parent pack, merge, auto-merge, close a pull request, or
deploy. The coordinator owns those Projects and owner-decision boundaries.
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
| Pull request state | Draft only |
| State location | `<absolute-git-common-dir>/projects-pr-v2/<packId>.json` |
| Verification | One command fixed and hashed at `prepare` |
| Push scope | `HEAD:refs/heads/<derived-branch>` only |
| Repository binding | Exact GitHub host and owner/repository from the declared remote |
| Base binding | Checked-out local base commit must equal the declared remote base commit |
| Success cleanup | Remove only the exact clean prepared worktree |
| Failure cleanup | Preserve the worktree and local branch for diagnosis |
| Merge authority | Owner-controlled; never requested by this controller |

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

The public library entry point is `@wornpage/projects-pr`. Its runner and
filesystem are injectable; focused tests replace all Git, shell, filesystem,
and GitHub CLI effects and create no real branch, worktree, push, or pull
request.

## Beta limitations

Run only one controller process per repository. Cross-process state locking is
not implemented, and child Git, shell, and GitHub processes do not yet have
controller-enforced timeouts. These are explicit beta limits, not silent
recovery paths.
