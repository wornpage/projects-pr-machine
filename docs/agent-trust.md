# Projects Pack Delegation trust guide

Read this before connecting the Codex integration. It separates the public local code in this repository from the hosted Wornpage Projects service and from tools already installed on your computer.

## Public local surface

Version 2.5.0-beta.3 includes:

- one `projects-pack-delegation` skill;
- three custom-agent definitions: coordinator, worker, and reviewer;
- the skill-local `projects-pr` controller and library;
- public copies of the expected MCP tool catalog and Worker Handoff v1 schema;
- plugin artwork and metadata.

The current source also contains unreleased, opt-in delivery commands. The
tagged beta artifacts above do not. Treat source behavior and installed release
behavior as separate until an owner-approved release is published.

The source installs no hook, daemon, background runner, model runtime, Node runtime, Git client, GitHub CLI, or global credential. The controller uses only Node built-ins and invokes its prerequisites at use time.

## Hosted service boundary

Full pack delegation connects to the separately operated Streamable HTTP MCP endpoint named in the plugin dependency metadata. MCP calls can read or mutate the Projects workspace authorized by the user's tenant-scoped token, role, and tool permissions. This repository does not contain the hosted service and cannot prove its uptime, authorization enforcement, logging, retention, incident response, or future behavior.

Use a separate personal Projects MCP token. Do not place it in prompts, commits, issue trackers, command arguments, or shell history. Removing local plugin files does not revoke a hosted token; revoke it separately through the Projects account surface.

The public files under `integrations/codex/projects-pack-delegation/contracts/` document the client contract. Live service behavior and policies remain authoritative.

## Git and GitHub capability boundary

Core Projects delegation can operate without the PR controller prerequisites. A PR request first runs read-only `doctor` before delegation or mutation. It checks:

- Node 22 or newer;
- Git;
- PowerShell 7 on Windows or `/bin/sh` on Unix;
- a clean Git top-level on the declared base branch;
- exact equality between the local and remote base commit;
- a credential-free GitHub HTTPS or SSH remote;
- GitHub CLI authentication and explicit push permission for that repository.

The controller then creates one derived branch and sibling worktree, stores the fixed verification command and its SHA-256, runs that command at finalization, pushes only the exact derived ref, and creates or resumes one verified draft PR. A reviewer must accept Worker Handoff v1 before the coordinator finalizes. `finalize` and `stack` never merge; close, deployment, and parent-pack completion remain owner decisions.

Optional source delivery remains off unless strict policy is read from
`.github/projects-pr-policy.json` at the exact GitHub base SHA. A PR cannot
authorize itself by changing the policy in its head. `authorize` records the
exact reviewed head plus separate coordinator-review and owner confirmations;
those attestations are not GitHub approvals or protection for merges outside
the controller. `finish` rechecks explicit publisher-bound checks and exact PR
identity, never follows a new head, and never uses native auto-merge.

The distinct admin path supports only a small exact set of active GitHub
ruleset requirements. It requires its own owner confirmation, reason, and full
bypass list. It refuses classic protection, status-check bypass, unknown or
inaccessible requirements, and the frozen
`github.com/wornpage/projects-webmcp-extension` repository. A prior normal
failure grants no admin authority.

For admin authorization, the controller observes classic protection through
the exact base `Ref.branchProtectionRule` with administrator viewer permission.
GitHub's aggregate REST `protected` flag includes both classic rules and
rulesets, so it is recorded but never used alone to infer classic-rule absence.

Optional stack linking requires an explicit `doctor --stack` pass and the exact official `github/gh-stack` extension. The controller does not install or update that extension. GitHub stack submission is not atomic; a failure may leave a partially linked remote stack, so recovery must repeat the same recorded bottom-to-top order.

## Arbitrary verification command

The verification command is owner-supplied arbitrary local shell input. The controller bounds its length, rejects line breaks, fixes and hashes it during `prepare`, and runs only that exact value during `finalize`. It does not interpret the command as safe and does not sandbox it. Review it before preparation, and never place a password, token, credential-bearing URL, or other secret in it because the exact command is persisted in lifecycle state.

## State, recovery, and beta limitations

Lifecycle state is stored under the repository's absolute Git common directory at `projects-pr-v2/<packId>.json`. It contains repository identity, branch and worktree paths, base and tested commits, the exact verification command and hash, lifecycle phase, and verified draft identity. The controller adds no dedicated bearer-token field and captures no verification output, but any secret supplied inside the verification command would be stored verbatim.

Delivery state is nested separately and binds repository, PR, base/head, policy
digest, check identities, authorization mode, merge receipt, and cleanup
outcome. Optional cleanup never calls `gh --delete-branch`; it retains local
state/evidence and uses one exact remote push URL plus an exact-value Git lease.
That lease rejects a different ref value at deletion time; it cannot identify
same-SHA delete/recreate history entirely between observations. Terminal
absence/recreation has a separate guard, while default/dependency/base and rules
observations remain non-transactional.

Success removes only the exact clean prepared worktree. Failures preserve diagnostic work and emit bounded receipts. `status` is read-only. `abort` refuses worker commits, dirty state, remote state, PR state, completed state, or inconclusive observations.

During beta:

- published beta clients require one controller process per repository; current
  unreleased source enforces an exclusive invocation lock for cooperating public
  CLI/library mutations. See [lifecycle locking](lifecycle-lock.md) for crash
  recovery and limits; worker edits, old clients, and separate clones are not locked;
- published beta draft-lifecycle processes have no enforced deadline; current
  unreleased public CLI/library source uses [bounded subprocesses](subprocess-timeouts.md):
  30 seconds by default, 15 minutes for verification, retaining existing explicit
  10/30-second limits. Uncertain termination retains an acquired lifecycle lock;
  descendant supervision and remote-outcome reconciliation remain separate;
- injected-effect tests cover command and mutation boundaries, and a disposable
  local bare Git remote covers lease races, but no hosted PR/merge/delete was
  tested.

## Source and release verification

Review the tagged source, [controller contract](projects-pr.md), [security policy](../SECURITY.md), and [provenance record](../SOURCE_PROVENANCE.md). GitHub release assets include a package tarball and SHA-256 checksum. Hashes establish byte consistency, not an independent publisher signature or hosted-service guarantee.

## Remove access

Remove the local plugin through the same installation mechanism used to add it. If the hosted Projects installer was used, follow its recorded manager/uninstall instruction. Then revoke the Projects token separately. Modified or ambiguous local files should be inspected rather than force-deleted.
