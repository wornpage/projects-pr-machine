# Real-process recovery rehearsal (WP-06b)

This increment adds regression tests, not process-tree supervision or new runtime
behavior. It exercises the WP-05a lock and WP-06a bounded runner/session together
using real Git repositories, parent/descendant processes, output pipes, timers,
and direct-child signals. No GitHub service, credentials, shell command, or
production repository is involved.

## Run

```sh
node --test test/process-tree-recovery.test.mjs
npm run check
```

The five cases are included by the existing `test/*.test.mjs` selection on Linux,
macOS, and Windows. No CI workflow, package dependency, production timeout, lock
policy, or review/delivery authority is changed. The child fixture is under
`test/fixtures`, outside the published package's allowlist.

## Scenarios and evidence

| Scenario | Required observations |
| --- | --- |
| Parent exits 0; descendant still owns output pipes | The operation and lock remain pending until descendant shutdown; complete output and exit 0 are preserved, then the lock is released. |
| Parent exits 7; descendant still owns output pipes | The same pipe-lifetime rule preserves exit 7 and complete output; an ordinary completed command remains distinct from uncertainty. |
| Parent exits before the deadline; descendant survives | The real timer expires, no signal targets the already exited parent, partial output is discarded, and the exact lock owner bytes are retained. |
| Parent remains running at the deadline | The runner attempts direct-child SIGKILL, returns uncertainty, and retains the lock while a descendant still responds. The test separately observes the direct child's exit. |
| Controller process is killed during its operation | The child and grandchild still respond, while a new invocation refuses the unchanged lock left by the killed controller. |

Fresh challenge/response messages over a private loopback connection demonstrate
that fixture processes are still executing after the interruption. A PID lookup,
a `kill()` return value, or a previously received readiness message is not treated
as sufficient evidence. In both deadline cases, a later runner call in the same
session must not execute, even though the operation callback deliberately swallowed
the failed subprocess result. Re-entry remains refused after fixture shutdown;
that shutdown does not authorize automatic removal of a retained lock.

Node distinguishes the child's `exit` event from `close`, because other processes
can share its standard streams. This is the failure mode tested here, not an
assumption that terminating a parent terminates its children. See the official
[Node child-process event documentation](https://nodejs.org/api/child_process.html#event-close).

## Test isolation and cleanup

Each case creates one disposable local Git repository and an ephemeral listener
bound only to `127.0.0.1`. A random per-case token associates fixture connections;
the protocol accepts only readiness, fresh pings, and fixed stop commands. It does
not evaluate received code or accept a hostname, executable, or PID to terminate.
This control channel is test infrastructure, not a production authentication claim.

The runner receives its normal spawn options without replacement streams or fake
timers. The test observes real spawning and direct-child kill calls through its
existing trusted test seam. Five-second fixture deadlines replace production
waiting periods only in the test invocation; readiness and process events, rather
than fixed sleeps, order the assertions. Output ordering between independent
processes is intentionally not prescribed.

Fixtures exit on control-connection closure and independently self-expire after
25 seconds. Teardown closes all owned connections, cleans up only direct child
handles created by the test, and removes only the test's disposable repository.
It never signals a PID learned from a message or enumerates/kills unrelated
processes. Descendant control-channel closure is a fixture shutdown observation,
not independent operating-system proof of arbitrary descendant quiescence.

## Boundaries

The crash fixture calls the existing lock and runner modules directly; it is not
an end-to-end invocation of the packaged CLI, private lifecycle core, or hosted
service. Existing public-entry tests cover their integration separately. Normal
foreground completion does not certify absence of detached work. Background
processes without inherited pipes, hostile processes, filesystem stalls, machine
crashes, and remote side effects are not certified by these tests.

Operator reconciliation remains necessary for a real retained lock. Do not
transfer test-directory cleanup into a production unlock operation. See
[subprocess bounds](subprocess-timeouts.md) and [lifecycle recovery](lifecycle-lock.md).
