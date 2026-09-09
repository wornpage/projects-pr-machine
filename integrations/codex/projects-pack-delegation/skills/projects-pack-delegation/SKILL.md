---
name: projects-pack-delegation
description: Delegate independent code work to Codex subagents through tracked Projects packs and Worker Handoff v1. Use for Projects pack delegation, subagent pack work, a PR machine, "make this a PR", "turn this pack into a PR", a draft PR, or any request to turn tracked agent work into a pull request.
---

# Projects Pack Delegation

Use the current session as coordinator. Projects stores coordination state;
Codex executes the work.

## Automatic model routing

Before every worker or reviewer spawn, classify the assignment from its scope,
risk, ambiguity, and verification burden. Pass an explicit `model` and reasoning
effort to the spawn; do not silently inherit the coordinator's model. Use only
models advertised as available by the current Codex host.

- **Light:** bounded discovery, documentation, formatting, deterministic data
  processing, or a narrow mechanical edit with a strong verification command.
  Use `gpt-5.6-luna` at `medium` for the worker.
- **Standard:** ordinary implementation, tests, a localized bug fix, or a
  coherent multi-file change with understood behavior. Use `gpt-5.6-terra` at
  `medium` for the worker; use `high` when meaningful edge cases remain.
- **Demanding:** ambiguous architecture, security/auth, concurrency, data
  migration, public contracts, cross-cutting changes, high blast radius, or a
  prior failed attempt. Use `gpt-5.6-sol` at `high` for the worker; use `xhigh`
  only when the extra reasoning is justified by the assignment.

Route review independently. Use `gpt-5.6-terra` at `medium` for light work,
`gpt-5.6-terra` at `high` for standard work, and `gpt-5.6-sol` at `high` for
demanding work. A reviewer may be stronger than its worker but must not be
weaker than this floor. On rework caused by a reasoning or correctness miss,
increase the worker by one tier or one reasoning level while keeping the same
pack, delegation key, branch, and worktree. Do not escalate environmental or
purely procedural failures.

Spawn routed agents with only the assignment contract and required context so
the model override is valid and unrelated conversation history is excluded.
When reporting the delegation, name the selected model, reasoning effort, and
one-sentence routing rationale. Model choice never relaxes verification,
handoff, review, sandbox, or owner-decision requirements.

## Core delegation

1. Call `whoami` once. Stop if the workspace is unresolved, write access is
   unavailable, or a required Projects tool is missing.
2. Create or claim the parent goal pack. Never complete it automatically.
3. Split only independent work. Use at most four children in one wave.
4. Call `delegate_pack` serially once per assignment, carrying the returned
   workspace version forward. Reuse its stable delegation key for rework.
5. Spawn only the returned assignments. Give each worker its `parentId`,
   `packId`, `workerId`, purpose, completion criteria, constraints, and exact
   verification command.
6. Let assigned children run concurrently. Wait through Codex task
   coordination; never poll Projects.
7. Have a reviewer validate every Worker Handoff v1. The reviewer recommends
   only `accept` or `rework`.
8. The coordinator alone calls `review_worker_handoff`, integrates accepted
   work, verifies the parent, and explicitly decides whether to complete it.

Workers call `submit_worker_handoff` exactly once. Completed handoffs require
nonempty completion evidence, a null blocker, and no failed reported test.
Blocked or failed handoffs require a concrete blocker and null completion
evidence.

## Draft PR flow

For any PR-machine or draft-PR request, use exactly one low-energy worker and
this sequence. Low energy means passing only the assignment contract,
worktree, constraints, and verification context; do not fork unrelated
conversation history.

1. Resolve `<skill-root>` to the absolute directory containing this
   `SKILL.md`. Set the only controller path to
   `<skill-root>/scripts/projects-pr.mjs` and invoke it with Node. Do not search
   `PATH`, use a global package, fall back to a repository script, or recreate
   the workflow from memory.
2. Before `delegate_pack`, run:

   ```text
   node <absolute-controller-path> doctor --repo <repository-root> --base <base-branch> --remote <remote>
   ```

   Continue only when the schema-v2 receipt reports `status: "ready"` and
   `capability.available: true`. If unavailable, show its bounded checks and
   stop the PR flow before delegation or mutation. Do not install tools. Core
   delegation remains available if the user chooses it separately.
3. Create or claim the parent, then call `delegate_pack` once for one child.
   Before spawning that worker, run:

   ```text
   node <absolute-controller-path> prepare --pack-id <child-pack-id> --title <title> --base <base-branch> --verify-command <fixed-command> --repo <repository-root> --remote <remote>
   ```

4. Spawn the assigned `projects_pack_worker` in the absolute
   `plan.worktreePath` returned by `prepare`. Require one or more commits, a
   clean worktree, the fixed verification command, and Worker Handoff v1.
5. Ask `projects_pack_reviewer` to review the handoff. The coordinator records
   `accept` or `rework`; never finalize rejected evidence. Rework uses the same
   pack, delegation key, branch, and worktree.
6. After acceptance, run:

   ```text
   node <absolute-controller-path> finalize --pack-id <child-pack-id> --repo <repository-root>
   ```

   Report the verified draft URL and owner-decision receipt. Finalization never
   merges or closes the PR.

Use `status --pack-id <id> --repo <root>` to inspect or resume recorded state.
Use `abort --pack-id <id> --repo <root>` only when the owner explicitly
abandons an unchanged, unpushed preparation; honor any refusal.

## Optional owner-authorized delivery

Use this only when the repository owner explicitly asks to deliver the one
finalized PR and a strict `.github/projects-pr-policy.json` was already merged
into its exact base commit. Never add or enable policy in the PR being
authorized. Missing policy means manual merge and retained remote branch.

1. Reconfirm that reviewer acceptance applies to the exact finalized head SHA
   and obtain explicit owner approval for that PR/base/head. Then run:

   ```text
   node <absolute-controller-path> authorize --pack-id <child-pack-id> \
     --reviewed-head <exact-sha> --confirm-review --confirm-owner \
     --repo <repository-root>
   ```

   These flags are coordinator attestations, not independent GitHub approvals.
   A new head or base invalidates them; never follow a moving branch.
2. Run the bounded, resumable finish operation:

   ```text
   node <absolute-controller-path> finish --pack-id <child-pack-id> --repo <repository-root>
   ```

   Report `waiting` checks and repeat only the receipt's exact finish command.
   Never add `--auto`, substitute `gh pr merge`, or start an indefinite watch.
   The controller requires every explicit publisher-bound check to succeed,
   freshly rechecks identity, and preserves local state and evidence.
3. Use `authorize-admin` only after a separate explicit owner decision names
   the reason and every supported observable GitHub ruleset requirement being
   bypassed. Pass each receipt value with `--bypass`. Admin authorization never
   follows a normal failure, bypasses required checks, or overrides repository,
   PR, base/head, frozen-repository, classic-protection, or unknown-requirement
   refusals.

Optional remote cleanup is policy-controlled and happens only after the exact
PR is recorded merged. It uses an exact-value remote ref lease and never removes
local branches, worktrees, state, or evidence. Stacks remain draft-only.

## Stacked draft PR flow

Use this only when the user explicitly asks for a stack or when one requested
PR-machine outcome has two or more independently reviewable, ordered layers.
Each layer still follows the complete one-worker Draft PR flow above and must
reach a verified `completed` state before linking. Do not use a stack to hide
unreviewed work, combine unrelated changes, or bypass per-layer verification.

1. Before delegation, require the stack-aware doctor receipt:

   ```text
   node <absolute-controller-path> doctor --repo <repository-root> --base <base-branch> --remote <remote> --stack
   ```

   Continue only when it reports `status: "ready"`, including the exact
   `github/gh-stack` extension and its `gh stack link` command. Do not install,
   replace, or update the extension automatically.
2. Delegate, review, and finalize every layer separately with the ordinary
   Draft PR flow. Keep each branch based on the same declared base; the stack
   command establishes GitHub's bottom-to-top PR base chain after all layers
   are accepted. Never run the stack command for prepared, pushed-only,
   rejected, non-draft, closed, or remotely divergent layers.
3. Supply completed pack IDs in exact bottom-to-top order:

   ```text
   node <absolute-controller-path> stack \
     --pack-id <bottom-pack-id> --pack-id <next-pack-id> [--pack-id <top-pack-id> ...] \
     --base <base-branch> --repo <repository-root> --remote <remote>
   ```

   The controller invokes only the official non-interactive `gh stack link`
   path, omits `--open`, and verifies every resulting PR remains open and
   draft, at the recorded commit, with the exact chained base. It never merges,
   enables auto-merge, or changes worker commits.
4. Treat a failed link as potentially partially applied because GitHub stack
   submission is not atomic. Inspect the bounded failure receipt, then rerun
   the exact same ordered `stack` command after resolving the reported remote
   condition. Do not reverse, omit, or append layers during recovery.
5. Report every verified draft URL in bottom-to-top order and preserve owner
   review as the final decision boundary. Stacking changes presentation and PR
   bases; it does not authorize merge, close, deployment, or branch deletion.
