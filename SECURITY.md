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
- Child Git, shell, and GitHub processes do not yet have controller-enforced timeouts. The operator may interrupt them; diagnostic state and worktrees are preserved on failure.
- The controller creates or verifies draft PRs only. Merge, auto-merge, close, deployment, and parent-pack completion remain outside its authority.
- The bundled Codex integration can connect to the separately operated Wornpage Projects MCP service. Its token, authorization, retention, and availability boundaries are described in [docs/agent-trust.md](docs/agent-trust.md).
