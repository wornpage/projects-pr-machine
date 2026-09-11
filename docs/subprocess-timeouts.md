# Bounded controller subprocesses (WP-06a)

This is unreleased source behavior, not an update to an installed beta client.
It adds deadlines and conservative interrupted-operation recovery at the existing
public CLI/package-library facade. It does not add a second lifecycle path or
change verification commands, owner approvals, handoff/review formats, or policy.

## Execution bounds

| Invocation | Deadline |
| --- | --- |
| Default non-shell Git, GitHub CLI, and prerequisite reads | 30 seconds |
| The recorded verification command, executed through the existing platform shell | 15 minutes |
| Existing explicit lock-discovery reads | 10 seconds, unchanged |
| Existing explicit delivery effects and observations | 30 seconds, unchanged |

The default runner uses Node `spawn` without an implicit shell. Verification still
uses `/bin/sh -c` on Unix or noninteractive `pwsh -Command` on Windows with the
original literal command. Standard input is closed; interactive commands are not
supported. Each output stream is limited to 1 MiB (2 MiB combined). Normal completed
commands preserve their exit code and captured stdout/stderr. These bounds do not
make arbitrary verification code safe or sandboxed.

The timer covers both child completion and output-pipe closure. A descendant
holding a pipe after its parent exits must not cause an unbounded wait. Timers
require a responsive Node event loop; these are not operating-system real-time
limits. Explicit internal `timeoutMs` values must be integer milliseconds from
1 through 900000. Invalid values fail before spawning instead of disabling the
deadline. No new CLI flag or environment override can extend/disable these limits.

On timeout, output overflow, a signal, or a process/stream error after spawning,
the runner discards partial output, attempts `SIGKILL` on the direct child if it
has not been observed exiting, disconnects output pipes, and stops waiting. It
never signals a previously observed exited PID. Refusal metadata contains fixed
reason codes, not command text, local paths, credentials, or subprocess errors.
A failed kill attempt remains uncertain, rather than permitting an indefinite wait.
A failure to spawn before a child exists is an ordinary nonzero result.

**An attempted kill is not proof that the child or its descendants stopped.**
Node documents that killing a shell can leave child processes alive. No automatic
process-tree kill, PID enumeration, group kill, or remote cancellation is claimed.
See the [Node child-process documentation](https://nodejs.org/api/child_process.html#subprocesskillsignal).

## Lock retention and recovery

Every public mutation gets a per-invocation runner session. Once any subprocess
reports uncertainty, the session latches it, makes even successful-looking partial
results nonzero/empty, and refuses to execute later subprocesses in that operation.
The latch exists outside the private core's normalized results and catch blocks.

Before releasing the acquired lifecycle lock, the public boundary checks that
session. An uncertain session produces `lifecycle_process_uncertain`, a failed
receipt, and `operationOutcome: unknown`; the original lock and owner record are
left intact. This is true even if core code caught the failure or returned a result.
The next cooperating mutating invocation refuses the existing lock. Neither a
successful-looking core receipt nor a retry creates permission to remove it.
An interrupted lock-discovery read fails before core dispatch; no new lock has
been acquired at that point. A standalone call to the exported default runner is
not a locked lifecycle operation; its caller must handle uncertainty itself.

The ordinary nonzero exit of a completed foreground command is still an ordinary
operation failure, allowing the existing owned-lock release and recovery behavior.
It is not independent proof that a command left no background effects. Commands,
runners, and local repository administration remain trusted.

Use the [interrupted-operation recovery procedure](lifecycle-lock.md). Stop writers,
establish that relevant processes and descendants are stopped, preserve evidence,
and reconcile the exact local state, remote ref, and PR. A remote mutation may
have succeeded despite lost output. Only then may an operator archive and remove
the exact retained lock and follow the original operation-specific resume path.
Do not blindly repeat a merge, push, cleanup, or verification command. Verification
can have side effects. No automatic takeover, rollback, or force-unlock is added.

`doctor` and `status` use bounded default runners but remain lock-free and do not
remove retained locks. An uncertain observation returns `subprocess_uncertain`
rather than a successful observation. They are not transactional snapshots.

## Trust and remaining work

The public module is `lib/projects-pr.mjs`; CLI and package paths are unchanged.
The private core stays byte-identical to WP-05a. Its legacy runner is not the public
default. All nine public operations pass the bounded default through the existing
runner dependency; nested core calls share that session. The public default runner
export also resolves to the bounded implementation.

Custom runners/filesystems are trusted test seams, not an alternate production
path. Injected runners must honor deadlines and report `processUncertain: true`
when completion is unknown; arbitrary thrown fixture errors retain their existing
semantics. The CLI accepts no runner or capture injection. This change does not
make arbitrary injected code bounded, and direct private-core imports bypass it.

Complete descendant supervision, abrupt controller termination, worker edits,
older clients, separate clones, hostile same-user tampering, filesystem stalls,
background processes with no inherited pipes, and remote transactions remain
outside this increment. Never interpret lock release as proof that detached work
was absent, or a deadline as proof that the hosted operation was cancelled.

No release, installed-client update, deployment, GitHub review bot, hosted acceptance
transition, branch-protection change, or new merge authority is installed here.

## Verification

Run `node --test test/bounded-process.test.mjs test/repository-lock.test.mjs test/projects-pr-lock.test.mjs`,
then the complete `npm run check`. Tests cover policy and literal arguments,
per-stream byte bounds, late events, retained pipes, failed termination attempts,
real subprocess timeout/overflow, and real Git lock retention/refusal. Public-entry
fixtures cover every mutation, read-only observation, and CLI failed receipts.
Simulated pipe/kill faults are not an assertion of full process-tree supervision.
