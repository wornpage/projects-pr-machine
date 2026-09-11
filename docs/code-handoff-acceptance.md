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
v1. This is the safe compatibility bound for this profile, not a change to the
standalone controller's 2,000-character input limit. Commands above the v1 bound
must be rejected **before delegation or preparation**. Do not trim, truncate,
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
