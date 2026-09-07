# Projects Pack Delegation for Codex

Version 2.5.0-beta.3 contains one coordinator skill, three Codex custom-agent
definitions, and the skill-local `projects-pr` JavaScript controller. Projects
stores coordination state; Codex performs work with the customer's existing
session and model subscription. Read the [trust
guide](../../../docs/agent-trust.md) before installation.

## Install

Create a personal token at `https://projectsdemo.org/agents`, then use the
service's manifest-verified command to connect the full Projects workflow. The
hosted installer and service are versioned separately from this public source
beta; inspect the version and source commit named by its manifest before
installing. The controller can also be installed independently from the
repository's GitHub release.

The integration installs no hook, daemon, model runtime, or global CLI. Core
pack delegation installs even when Node, Git, or GitHub CLI is unavailable.
Those tools are optional PR capability prerequisites and are checked again at
use time.

## Delegate tracked work

Ask Codex to use `projects-pack-delegation`. The parent session coordinates;
it stays single-agent unless two to four bounded assignments have independent
scopes, disjoint write sets, concrete completion evidence, and a clear
concurrent critical-path benefit. It records that structured choice on the
parent with `update_pack.agentExecution`. Qualifying assignments are delegated
serially, only returned workers start, and each spawned child is bound through
`bind_delegation_thread` before it submits Worker Handoff v1. The binding uses
the returned child `packId`, Codex's provider-neutral task ID, and an optional
absolute HTTPS task URL when Codex supplies one. Every handoff is reviewed; the
parent owns every final decision and never polls Projects.

Projects retains only that immutable thread identity plus server binding
stamps—never the chat transcript, token, session, or provider payload. The
binding is visible on the child and parent delegation receipt, which lets a
coordinator identify and resume the exact Codex task after interruption. Rework
continues in the same child task and pack; it never binds a replacement.

Before each worker and reviewer starts, the coordinator classifies the
assignment as light, standard, or demanding and explicitly selects a supported
Codex model and reasoning effort. Light workers use Luna, standard workers use
Terra, and demanding workers use Sol; review is routed independently with a
quality floor and correctness rework escalates one tier or reasoning level.
The coordinator starts with the cheapest tier that can reliably satisfy the
contract and does not treat a bounded additive public API as demanding merely
because it is exported. It reports its choice and rationale instead of silently
inheriting the parent model.

Public copies of the expected MCP tool catalog and Worker Handoff v1 schema are
included in [`contracts/`](contracts/). They document the client boundary; the
separately operated service remains authoritative for live authorization and
behavior.

## Turn one pack into a draft PR

Natural requests such as “make this a PR”, “turn this pack into a PR”, or “use
the PR machine” trigger one deterministic path:

1. Resolve only the controller beside the installed skill and run read-only
   `doctor` before delegation.
2. Delegate one low-energy child, then run `prepare` to create its isolated
   worktree.
3. Give that exact worktree to the assigned side-chat worker, then bind its
   task ID and optional HTTPS URL to the child pack before terminal handoff.
4. Require Worker Handoff v1 and reviewer acceptance.
5. Run resumable `finalize` to verify, push the derived ref, create and verify
   a draft PR, and clean the worktree.

`status` inspects recorded state. `abort` removes only a safe, unchanged,
unpushed preparation. Merge and close remain owner decisions. There is no
PATH lookup, global package, source-repository fallback, `--execute`, or
arbitrary worker command in the installed flow. See
`../../../docs/projects-pr.md` for the controller receipt contract.

Two or more independently reviewed and completed drafts may be linked in
bottom-to-top order with `projects-pr stack`. This optional path first requires
`doctor --stack`, accepts only the official `github/gh-stack` extension, and
verifies that every PR remains open, draft, repository-bound, and at its tested
commit. Stack linking is not atomic, so failures preserve the exact ordered
recovery command.

## Uninstall

Use the durable manager under `$CODEX_HOME/.projects-pack-delegation` as shown
on the Agents page. It removes only unchanged state-owned files and the
matching Projects config section. Revoke the personal token separately;
removing local files does not revoke hosted access.
