# CI gate scheduler rehearsal (WP-04b)

This manual-only workflow exercises real GitHub job failure, matrix aggregation,
and skip propagation with inert fixtures. It does not run production tests or
change `.github/workflows/ci.yml`, required-check settings, or application state.

The fixture dependency IDs match the production gate's four groups. All fixture
runners are Ubuntu; names explicitly distinguish the macOS, CodeQL, and semantic
stand-ins from actual checks. One matrix cell is the successful control, and a
second cell can fail intentionally. The `Rehearsal gate` decision program is
byte-identical to the production `CI gate` program. The Node regression test
compares them so a later gate change requires an explicit rehearsal update.

## Run and interpret

After owner-approved merge places this workflow on the default branch, open
Actions, select **CI gate rehearsal**, choose **Run workflow**, select the
reviewed branch and scenario, and inspect the resulting jobs and logs.
No automatic PR, push, schedule, or workflow-run trigger is retained.

| Scenario | Matrix group | Skip fixture | Rehearsal gate | Overall run |
| --- | --- | --- | --- | --- |
| `success` (default) | Success | Success | Success | Success |
| `failure` | Failure from the probe cell | Success | Failure | **Failure, expected** |
| `skipped` | Success | Skipped | Failure | **Failure, expected** |
| `mixed` | Failure from the probe cell | Skipped | Failure | **Failure, expected** |

The always-run **Rehearsal observation** job must succeed and report
`matched: true` with `reason: expected_outcomes_observed`. It compares the exact
expected dependency set and results, including the gate result. A skipped,
cancelled, missing, or unexpectedly successful gate is not accepted for a
negative scenario. Inspect its receipt rather than treating any red run as proof
of correct rejection: runner failures or unrelated script errors can also be red.

Negative scenarios intentionally leave the entire rehearsal workflow red.
There is no `continue-on-error`, synthetic success status, or hidden retry.
Do not configure any rehearsal job as a required merge check, and do not bypass
or weaken the production gate to accommodate an intentional negative run.

The workflow has empty token permissions (GitHub retains implicit metadata read),
no checkout, no actions or package installs, and two/three-minute job timeouts.
Inputs and needs context enter scripts only as environment data. Node processes
produce bounded receipts without echoing arbitrary input; the GitHub runner can
still display environment values, so fixture context must never contain secrets.

## Recorded live experiment

On September 11, 2026, [run 34635446749](https://github.com/wornpage/projects-pr-machine/actions/runs/34635446749)
used the draft-branch fixture commit
`1ba907c513c3e88683f83d54866ad73e800a8e72`. A temporary PR trigger selected `mixed`;
the final candidate removes that trigger and restores the successful default.
No production workflow or branch-protection setting was changed for the test.

GitHub reported: control matrix cell success, probe matrix cell failure, skip
fixture skipped, and both remaining stand-ins successful. The rehearsal gate
ran after those outcomes and failed. Observation job `103382142132` succeeded;
its receipt recorded `test: failure`, `macos-smoke: skipped`, `codeql: success`,
`handoff-semantics: success`, and `ci-gate: failure`, all matching expectations.

This is a live **combined failure/skip** test, not separate hosted runs for each
mode. All four modes are checked locally. Cancellation, runner outage, timeout,
merge queues, protected-branch enforcement, and the production matrix's exact
platform inventory are not established by this experiment. The manual UI path
is documented for post-merge use; the recorded run used a temporary PR trigger.

## Local verification

```sh
node --test test/ci-gate-rehearsal.test.mjs test/ci-gate.test.mjs
```

The new tests execute the actual inline gate and observer programs, compare the
gate copy, and guard manual-only triggering, expected dependency IDs, runner
bounds, and absence of credentials/actions/error tolerance. They are discovered
by the existing `npm test` and `npm run check`; no dependency is added.
These are decision-program and configuration regressions, not a GitHub scheduler
emulator, evidence authentication, or independent code review.

GitHub's scheduler and dispatch contracts are documented in
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)
and [workflow dispatch events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
