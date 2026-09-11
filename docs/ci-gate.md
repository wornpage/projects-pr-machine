# Aggregate CI gate (WP-04a)

The `ci-gate` job in `.github/workflows/ci.yml` has the stable display name
**CI gate**. It is a candidate required status check, not a repository rule.
This change does not modify branch protection, authorize merging, activate the
hosted handoff-acceptance service, or create a deployment.

## What it checks

The job directly needs `test`, `macos-smoke`, `codeql`, and `handoff-semantics`.
With the current two-OS/two-Node test matrix, those four dependency groups cover
seven prerequisite jobs. Every group must report the exact string `success`.
A failure, cancellation, skip, neutral/unknown result, malformed job record,
missing dependency, or unexpected dependency makes the gate exit nonzero.

The inline program reads GitHub's `toJSON(needs)` from an environment variable.
It accepts at most 16,384 UTF-8 bytes and does not evaluate context values,
execute reported commands, use dependency outputs, or print raw context data.
It emits a small JSON result containing only fixed reason codes and known job
names/results. GitHub may display step environment variables in its own logs;
never put secrets in upstream job outputs. The program's redaction is not a
promise that the Actions runner conceals arbitrary environment values.

The job has `if: ${{ always() }}` so an unsuccessful prerequisite does not
silently skip the aggregate evaluation. It runs on a fresh Ubuntu 24.04 hosted
runner, uses its installed Node executable, has a three-minute job timeout,
requests no token permissions, and performs no checkout, dependency install,
network call, or repository mutation. If the runner or Node is unavailable,
the check cannot become successful. A cancelled/absent workflow is not success
and must never be waived by a consumer waiting for this check.

## Verification and maintenance

Run the dependency-free regression suite with the repository's supported Node:

```sh
node --test test/ci-gate.test.mjs
npm run check
```

The focused tests extract and execute the actual inline program using a bounded
Node subprocess, rather than a second copy of its logic. They cover unsuccessful
and malformed results for each dependency, missing/unexpected jobs, input-byte
limits, data that resembles executable code, exit status, and diagnostic
redaction. Layout and configuration assertions require the gate's always-run
condition, exact dependency list, no checkout/actions, and empty permissions.
They also guard the current upstream matrix, absence of conditional skipping
and error tolerance, and inclusion of every workflow job in the denominator.
The extractor intentionally recognizes this checked-in layout; a layout change
must update the tests instead of silently omitting execution coverage.

The existing jobs remain unchanged. Review additions to the workflow, matrix,
conditionals, error handling, gate, and tests together. Never make a new required
job invisible to the gate, hide errors with `continue-on-error`, or remove a
failing test to make a run green. These repository tests detect accidental drift;
they are not protection against a contributor changing the tests and gate
simultaneously.

The `needs.test.result` value is GitHub's matrix-job result, not a separately
queried inventory of matrix cells. The static matrix and lack of error-tolerant
jobs/steps are part of this design. The gate does not authenticate a worker's
report, audit every test assertion, identify stale external evidence, or replace
independent code review. CodeQL job success means that job succeeded; any
additional code-scanning severity/merge policy remains a separate control.

## Owner-controlled adoption

After this change is merged and the actual `CI gate` check has been observed on
the intended branch, the repository owner can separately configure the exact
check as required and select the expected GitHub Actions publisher. Retain
existing required checks and independent-review rules until the complete policy
has been verified. The aggregate job alone does not block direct pushes or
merges outside that policy and does not bind its name to a particular workflow
against malicious edits. Protect workflow and review-policy changes through
repository review requirements and the appropriate owners.

The current workflow retains its existing push-to-main and pull-request events.
Before enabling a merge queue, add and test the appropriate `merge_group`
trigger; it is deliberately not added or claimed by this patch. Verify failing,
skipped, and cancelled cases in an authorized disposable workflow before
relying on this check as the only aggregate requirement. Local JSON fixtures
exercise the decision program, not GitHub's scheduler or protection settings.

## GitHub references

- [Job dependencies and always conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)
- [Needs context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context)
- [Required-status-check behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
- [Safe handling of expression data](https://docs.github.com/en/actions/reference/security/secure-use#use-an-intermediate-environment-variable)
