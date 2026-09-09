# Security policy

## Supported versions

Security fixes are provided for the latest tagged beta or stable release.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not include repository credentials, Projects tokens, private source, or customer data in a public issue.

For ordinary defects that do not expose sensitive information, open a GitHub issue.

## Trust boundaries

- `projects-pr doctor` is read-only. Mutating lifecycle commands must not run when its required checks fail.
- The fixed verification command is intentionally arbitrary local shell input supplied by the repository owner. The controller hashes and stores it verbatim; it does not sandbox it. Review the command before `prepare`, and never put a password, token, credential-bearing URL, or other secret in it.
- Git and GitHub CLI run with the current user's credentials and repository permissions.
- State under the Git common directory is trusted local control data. Do not edit it manually.
- One controller process per repository is supported during beta. Cross-process locking is not yet implemented.
- Existing draft lifecycle child processes do not yet have controller-enforced timeouts. New delivery observations and mutations have a 30-second per-process bound and return resumable receipts; the operator may interrupt other operations, and diagnostic state and worktrees are preserved on failure.
- `finalize` and `stack` never merge. Optional delivery is disabled unless a strict policy is read from the exact GitHub base object and separate coordinator-review and owner confirmations bind the exact PR/base/head. Coordinator attestation is not an independent GitHub approval and cannot protect merges performed outside this tool.
- A normal `finish` requires publisher-bound checks to report exact-head success twice and GitHub to report the PR clean and mergeable; it uses the synchronous merge endpoint with an exact head SHA. A distinct admin authorization records a reason and the complete supported observable ruleset bypass list. It cannot bypass tool-required checks, classic protection, identity, base/head binding, frozen repositories, or unknown/inaccessible requirements.
- Optional remote cleanup validates one exact non-mirror push destination and uses `--force-with-lease=<ref>:<reviewedSHA>` to delete only the merged controller branch. The lease rejects a different ref value at deletion time, but cannot distinguish same-SHA delete/recreate history entirely between observations; terminal recorded absence/recreation is guarded separately. Default/shared/dependent/stack and base/rule observations are not transactionally locked. Local branches, worktrees, state, and evidence are retained.
- The bundled Codex integration can connect to the separately operated Wornpage Projects MCP service. Its token, authorization, retention, and availability boundaries are described in [docs/agent-trust.md](docs/agent-trust.md).
