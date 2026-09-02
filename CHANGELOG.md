# Changelog

## 2.5.0-beta.2 - 2026-09-01

- Makes the stack controller fixture portable across PowerShell 7 and `/bin/sh` CI hosts.
- Supersedes beta.1, whose controller and release assets were valid but whose Unix stack test fixture omitted the shell capability stub.

## 2.5.0-beta.1 - 2026-09-01

- First public Wornpage PR Machine source release.
- Publishes the stack-aware controller used by the installed Projects pack-delegation workflow.
- Keeps the draft-only, one-worker, fixed-verification, exact-ref push, resumable-receipt, and owner-controlled merge boundaries.
- Adds optional ordered draft-stack linking through the official `github/gh-stack` extension.
- Requires the checked-out base commit to match the declared remote base before preparation.
- Adds standalone package, CI, security, provenance, and challenge-extension evidence.

This is a beta because controller child-process timeouts and cross-process lifecycle locking are not yet implemented.
