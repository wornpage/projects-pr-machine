# Repository lifecycle locking (WP-05a)

This is unreleased source behavior. It does not update an installed beta client.
Use an owner-approved release before treating a deployed client as lock-aware.

## Protected boundary

The public controller library and its existing CLI acquire one exclusive lock
for each invocation of `prepare`, `finalize`, `abort`, `stack`, `authorize`,
`authorize-admin`, or `finish`. No option disables locking. The existing public
module/export paths and command grammar are unchanged. The former library body
is preserved byte-for-byte in a private `lib/projects-pr-core.mjs` implementation;
`lib/projects-pr.mjs` is the public locking boundary. Internal core imports and
custom dependency injection are unsupported as an alternative execution path.

Before entering a mutating operation, two fixed, bounded Git reads establish the
checkout top level and Git common directory. The filesystem path is canonicalized,
so linked worktrees share the repository's lock. The lock is an exclusive directory
named `projects-pr-v2.lock` directly under the Git common directory, beside (not
inside) the existing `projects-pr-v2` state directory. No remote request is needed
to acquire it. Different Git common directories remain independent.

An existing lock path causes immediate `lifecycle_locked` refusal, whether it is
a directory, file, or symlink. The controller neither waits nor automatically
steals it. The invocation holds its lock across the entire awaited operation,
including verification, state writes, remote effects, and cleanup, then releases
it on success or ordinary thrown failure. Nested implementation calls remain
inside that outer critical section; there is only one lifecycle implementation.

The owner record contains a random token, process ID, and start time, not pack
identifiers, paths, command text, credentials, or verification output. PID/time
are diagnostic hints only. Release checks the directory and file identities,
regular-file metadata, exact original owner bytes, and absence of foreign
contents. It unlinks only the owner file and removes the empty directory; it
never recursively deletes. Repeated release calls share the original outcome.

## Observation and failure

`doctor` and `status` remain read-only and do not acquire a lock or repair one.
They can observe a running operation, but their results are not a transactional
snapshot and must not be used to infer exclusive ownership.

The CLI uses its existing failed-receipt envelope with explicit lock error codes:

- `lifecycle_locked`: an existing path prevented entry; no core operation started.
- `lifecycle_lock_unavailable`: repository discovery or exclusive creation failed.
- `lifecycle_lock_initialization_failed`: a partial lock is retained for inspection.
- `lifecycle_lock_release_failed`: ownership or cleanup was uncertain. The receipt's
  `operationOutcome` distinguishes `returned` from `failed`; effects may already
  have occurred in either case. Inspect state before considering a retry.

Lock-specific receipts omit underlying subprocess output and verification text.
Their recovery points to `status` for a valid pack, otherwise `doctor`, plus this
operator procedure. No lock error authorizes a second merge, push, or deletion.
An ordinary core error retains its original receipt when lock release succeeds.

## Interrupted-operation recovery

A killed process, host crash, failed owner initialization, or failed release can
leave a lock behind. There is deliberately no expiry, PID-only recovery, automatic
unlock, or force flag: a surviving verification/Git/GitHub subprocess may still
be performing effects after the parent is gone.

Stop new writers first. Inspect the exact repository's lock record and lifecycle
state, identify the operation and its process tree, and establish that all relevant
local processes have stopped. Observe the exact remote branch and PR through the
existing status/recovery procedure; do not assume a missing local success receipt
means a remote effect failed. Preserve diagnostic state and worktrees.

Only an operator who has established quiescence may archive the lock evidence and
remove that exact lock directory. Do not delete `.git/index.lock`, unrelated lock
files, the `projects-pr-v2` state directory, branches, or worktrees as a shortcut.
Malformed or foreign contents require investigation, not recursive deletion.
Then run `status` and follow the existing operation-specific resume path. The
controller does not perform this manual recovery or infer that it is authorized.

## Limits

This is a cooperating-process mutex on a supported local filesystem, not a
security sandbox, distributed lease, or transaction over GitHub. Network/shared
filesystem behavior is not certified. Separate clones have separate locks.
Old clients, direct Git/gh commands, private-core imports, and worker edits do not
participate. Node/Git binaries, local repository administration, runner/filesystem
dependencies, and same-user process/environment integrity remain trusted.

The lock serializes controller invocations, not the whole prepare-to-finalize
interval. Workers must still be quiescent during review/finalization. It does not
close review-to-mutation races involving nonparticipants, protect against hostile
same-user replacement of filesystem entries, or prove reviewer/test authenticity.
Hung operations retain the lock; existing draft subprocess timeouts remain a
separate work item. No signal handler removes the lock while children may live.

Snapshot/report validation, exact revision and publisher checks, frozen-repository
rules, explicit owner approval, and branch protection retain their distinct roles.
There is no release, installed client update, hosted acceptance change, GitHub
review bot, branch-protection change, or new merge authority in this patch.

## Verification

Run `node --test test/repository-lock.test.mjs test/projects-pr-lock.test.mjs`,
then the complete `npm run check`. Fixtures use disposable local repositories and
separate Node processes; no hosted merge or production resource is needed. Existing
lifecycle/delivery tests must pass through the unchanged public import path so
lock integration is exercised alongside established refusal and recovery behavior.
