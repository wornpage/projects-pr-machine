# Local draft-delivery rehearsal (WP-07a)

This is source-level integration evidence, not hosted end-to-end delivery, an
installed-client update, a production acceptance gate, or permission to merge.
It follows the real-process recovery tests with a real Git draft lifecycle.

## What actually executes

Each command starts a fresh Node process. The test driver imports the canonical
CLI `main` function, so the real argument parser, JSON receipts, public facade,
repository lock, lifecycle core, and bounded subprocess runner execute. Controller
state and the local service stand-in persist on disk across processes. This does
**not** test the package binary's no-injection bootstrap or an installed release.
The existing trusted runner seam supplies the stand-in; no CLI option or runtime
API is added. No core implementation is copied into the test.

Git operations use a disposable checkout and bare origin: actual objects, branch
refs, linked worktrees, ancestry, status, push, and worktree removal. Verification
runs the recorded `node verify.mjs` command through the production platform shell.
The fixture records the observed Git HEAD from inside that script, independently
of the controller's verification receipt. The script is trusted test code, not
user-supplied code. Runtime deadlines and output caps are unchanged; the driver
has its own 30-second test deadline and each scenario has a 90-second test bound.

Two boundaries are simulated. The adapter presents a synthetic GitHub identity
only after checking that the real origin is the expected local bare repository
with no push-URL override. It answers a small closed set of `gh` capability,
repository, draft-list, draft-create, and draft-read requests from a local JSON
file. It never starts a real `gh` executable. Draft creation records the actual
bare-origin head, rather than a hard-coded object ID. Unknown commands fail;
there is no generic-success fallback. The stand-in deliberately permits duplicate
create effects so a defective retry is detected, not hidden by mock idempotency.

The successful path also invokes the real snapshot and report guards and compares
their inventory with an independent Git diff read. Its report is an explicitly
synthetic consistency-test input. It is **not independent human/agent approval**,
and does not activate report checking inside `finalize`. The caller invokes the
guard explicitly, as the existing coordinator protocol requires.

## Regression scenarios

| Scenario | Required observation |
| --- | --- |
| Doctor, prepare, work, report check, status, finalize, replay | One exact pushed head and one draft; complete state, actual verification, owned cleanup, main unchanged |
| Completed local push followed by lost response | Status observes the real ref; restart reuses it without a second push |
| Simulated draft creation followed by lost response | The stored draft is observed and reused, not created twice |
| Uncertain result after a real local push | Original owner bytes retained; no later runner invocation in that session; a fresh mutation refuses the lock |
| Verification exits nonzero | No publish effect; diagnostic worktree preserved; raw verification output excluded from receipt |
| Verification dirties the worktree | Publication refused before push or draft creation |
| Verification commits a new HEAD | Publication refused despite successful command completion |
| Unchanged preparation versus committed worker work | Safe abort removes only the former and preserves the latter |
| Remote topic exists at another head | No overwrite or draft creation |
| Local and remote base disagree | Refusal before verification or publication |
| Worker adds a commit after report validation | Old context rejected; a fresh report validates the revised head before the test finalizes it |

The response-loss cases inject a completed-command failure *after* recording the
real/simulated effect. They are not live network failures. The uncertainty case
injects metadata after a completed local push; actual hanging children and
controller crashes are covered separately in the process-tree rehearsal.
The test explicitly observes status before retrying known response-loss cases.
It never removes an uncertain lock to get a retry to pass.

A completed `finalize` replay returns the existing controller receipt without
re-running verification; it is not a fresh hosted observation. The rehearsal
checks this cached behavior without treating it as proof that a PR cannot later
change. Exact remote checks at owner-authorized delivery remain a separate path.

## Fixture containment

All created repositories, worktrees, service records, evidence, and temporary home
files are under a freshly created test-owned directory. Mutating adapter calls
and verification require a lock owner record for the current command process.
Cleanup removes only that disposable directory. It is not production recovery.

The child environment is allowlisted: no inherited Git redirection/configuration,
`NODE_OPTIONS`, GitHub credentials, SSH agent, or proxy settings. Git is restricted
to the file transport, with system/global config, hooks, fsmonitor, signing, and
line-ending conversion isolated for reproducibility. Git documents its
[protocol policy](https://git-scm.com/docs/git-config#Documentation/git-config.txt-protocolallow)
and [environment controls](https://git-scm.com/docs/git). Node documents explicit
[subprocess environments](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options).

This is not an operating-system sandbox. The executable search path, Node/Git/
PowerShell installations, filesystem, fixture source, and same-user processes
remain trusted. Arbitrary verification code would need separate containment.
No merge, readiness, admin bypass, or remote-ref deletion is implemented by this
stand-in. No real GitHub repository is created, mutated, or removed by the tests.

## Reproduction and interpretation

Run `node --test test/local-delivery-fixture.test.mjs` for the adapter tests, then
`node --test test/local-delivery-rehearsal.test.mjs` for the CLI/lifecycle cases,
and finally `npm run check` for the whole repository and package contract. The
existing cross-platform CI selects both test files; no workflow change is needed.
The six adapter tests include seventeen explicit rejected command/path cases.
No platform-specific skips are used.

The failed-verification receipt records the **shell** exit code. For the fixture's
native Node script exiting 7, `/bin/sh -c` returns 7, while the existing Windows
`pwsh -Command` invocation returns 1. Microsoft's [PowerShell command documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh#-command--c)
describes this mapping when the command does not explicitly forward the native
exit status. A separate real-process adapter test compares the exact same script
with and without the platform shell. Both results must be ordinary failures,
not uncertainty, and both must show that the verification script actually ran.
The recorded command and production shell behavior are not modified for the test.

A passing local rehearsal cannot certify GitHub permissions, rulesets, network
failure behavior, server-side acceptance, hosted reviewer identity, merge queues,
a deployed artifact, or rollback. A separately authorized disposable hosted
repository and independent review remain required before claiming those results.
