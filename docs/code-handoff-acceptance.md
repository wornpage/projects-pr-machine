# Candidate: assignment-aware code handoff acceptance

This additive helper builds a JSON Schema for **one completed code assignment**.
It does not change Worker Handoff v1, execute a command, record acceptance, or
add a new controller lifecycle. It is not connected to the hosted service by
this patch. A successful validation is necessary evidence-shape validation,
not proof that the worker ran a command or that the implementation is correct.

## Scope and compatibility

`contracts/code-handoff-acceptance.mjs` combines the existing v1 schema with
constraints derived from a trusted assignment: exact pack and worker identities,
completed status, non-whitespace completion evidence, and at least one report
of the exact required command with `passed: true`. The original schema continues
to reject any failed reported test in a completed handoff and unknown fields.

The helper returns a self-contained Draft 2020-12 schema without the base
schema's `$id`. Different assignments must never share a schema-cache key.
The original v1 schema is unchanged. Use it, not the code-acceptance profile,
when recording blocked/failed handoffs or another explicitly defined work type.
Do not downgrade a rejected code assignment to a non-code path to bypass review.

The supported command limit remains **500 Unicode code points**, derived from
v1. The initial profile did not narrow the standalone controller's legacy
2,000-unit input limit. WP-02c now enforces the v1 bound for new public plans
and preparations, as described below. Commands above this bound must be rejected
**before delegation or preparation**. Do not trim, truncate,
normalize, substitute, or split the agreed command after assignment. A later
coordinated service/client contract migration is required to support longer
commands end to end. This patch does not implement that migration.

## Integration requirements (not implemented by this patch)

Read canonical `packId`, `workerId`, and `verificationCommand` from the trusted
assignment store. Never infer the assignment or expected command from the
worker's own report. Call `createCodeHandoffAcceptanceSchema(assignment)` before
delegating code work; invalid identity or command input throws a bounded
`TypeError` with a machine-readable `code` and no reflected command text.

At acceptance time, reload the current authorized assignment, regenerate the
profile, and validate the complete handoff with the service's trusted Draft
2020-12 validator. Do not coerce types, add defaults, remove unknown properties,
or treat compilation errors as success. A failed validation must prevent an
`accept` transition. Preserve the established blocked/failed recording flow.

For a service using JavaScript, the profile construction is:

```js
import { createCodeHandoffAcceptanceSchema } from
  '../integrations/codex/projects-pack-delegation/contracts/code-handoff-acceptance.mjs';

// trustedAssignment is canonical server/coordinator data, not handoff fields.
const schema = createCodeHandoffAcceptanceSchema(trustedAssignment);
// Compile and validate with the service's existing Draft 2020-12 validator.
// No validator or hosted authorization implementation is added by this helper.
```

Choose the import path relative to the actual caller. A generated schema embeds
assignment IDs and command text; treat it as scoped assignment data, do not log
it indiscriminately, and never include credentials in commands.

Keep the independent reviewer and coordinator decision after validation. This
profile does not bind a Git SHA, authenticate test evidence, implement tenant or
role authorization, or prevent replay of a previously accepted revision. Those
requirements need separate trusted enforcement. Non-whitespace evidence can
still be false, irrelevant, or inadequate; the reviewer must evaluate it.

## Verification and rollout

`node --test test/code-handoff-acceptance.test.mjs` covers the profile builder,
compatibility limits, mutation isolation, and failure inputs. The existing
`test/*.test.mjs` command is expected to discover these tests without changing
CI. The builder tests are not a substitute for exercising real payloads with the
hosted validator.

Before integration, run the full repository `npm run check`, validate positive
and negative handoff fixtures with the actual hosted validator, and test the
service's authorized acceptance transition. Do not enable a new acceptance
policy based only on a local profile-generator test. Follow CONTRIBUTING.md's
issue-first process before changing the public authority boundary.

## New controller assignments (WP-02c)

The public `createProjectsPrPlan` and `prepareProjectsPr` functions, including
CLI `projects-pr prepare`, now require a verification command that fits this
handoff contract: **1-500 Unicode code points**. The limit is read from the
existing v1 schema through `CODE_HANDOFF_V1_COMMAND_MAX_LENGTH`. Supplementary
characters count once, not twice; combining sequences count by code point, not
by displayed character. A 500-emoji string fits the length rule (this says
nothing about whether it is an executable or useful command).

New commands must be primitive, well-formed Unicode strings with no surrounding
whitespace, NUL, CR, LF, or Unicode line/paragraph separator. The library requires
an own data property; inherited commands, accessors, boxed strings, and implicit
string conversion are refused. No trimming, Unicode normalization, truncation,
quoting, or command substitution is performed. Accepted command bytes are hashed
unchanged. Invalid input returns `ProjectsPrError` / `invalid_input` without
reflecting the command text. Preparation refuses it before repository reads,
lock acquisition, subprocess invocation, or state creation. Plan values are
captured before asynchronous lock discovery so caller mutation cannot replace
the validated command while preparation is in progress.

This deliberately narrows **new-assignment** input compatibility. Previously the
controller allowed up to 2,000 UTF-16 units and normalized/coerced input, which
could create an assignment that the handoff/review helpers could not represent.
For longer verification logic, commit a reviewed script and assign its short
literal invocation, for example `node scripts/verify.mjs` or `npm run check`.
Review the script and any referenced package scripts at the pinned revision;
hashing the invocation alone does not make those implementations immutable.
Never split, truncate, or substitute the command in a worker's evidence.

The private lifecycle core and saved-state schema remain unchanged. Existing
state is not migrated or rewritten: observation and existing recovery rules still
read its original command/hash. Regression fixtures demonstrate read-only status
and safe abort of unchanged preparations with 600- and 2,000-unit commands.
They do not establish every historical state or a legacy finalize/merge path.
Repeating `prepare` with a legacy incompatible command now refuses. An old long
assignment still cannot pass the v1 review profile: preserve its work and evidence
and use owner-directed re-assignment/review with a reportable command. Do not edit
saved hashes, bypass review, call private core, or delete a production lock to
force it through. Abort continues to refuse worker changes or published work.

This guard does not execute verification, restrict shell operators, authenticate
evidence, enforce hosted acceptance, or authorize delivery. Library callers,
local tools, and ordinary object operations remain trusted; this is not a sandbox.
Other public exports, runtime deadlines, locking rules, and delivery authority
are unchanged. The source change does not update an installed client or publish
a new version.

Focused regression commands:

```sh
node --test test/verification-command.test.mjs test/code-handoff-acceptance.test.mjs
node --test test/public-verification-command.test.mjs test/projects-pr-lock.test.mjs
npm run check
```

The public integration cases reuse the local Git rehearsal fixture; GitHub
responses are simulated and no real `gh` process is invoked. Actual platform and
installed-package CI outcomes must be inspected separately from pure helper tests.
