# WebMCP challenge extension case study

## What the public record establishes

As of 2026-09-01 UTC, the public [`wornpage/projects-webmcp-extension`](https://github.com/wornpage/projects-webmcp-extension) repository contained 67 pull requests. Thirty-two merged pull requests used `projects-pr/task-*` head branches and were created from Projects pack handoffs between 2026-08-27 and 2026-09-01.

Their pull-request bodies carry a pack identifier and verification-command SHA-256, retain owner review as the decision gate, and state that the controller does not merge or enable auto-merge.

| Example | What it demonstrates |
| --- | --- |
| [PR #1](https://github.com/wornpage/projects-webmcp-extension/pull/1) | First public challenge-repository PR made through the controller |
| [PR #38](https://github.com/wornpage/projects-webmcp-extension/pull/38) | Durable pending-approval behavior delivered through the owner gate |
| [PR #70](https://github.com/wornpage/projects-webmcp-extension/pull/70) | Later challenge-period feature delivery through the same branch convention |

## What the public record does not establish

GitHub attributes both PR creation and merging to the `wornpage` account. The public PRs do not expose independent GitHub review records for this workflow, and most do not expose a current check rollup. Therefore this case study does not claim autonomous authorship, independent review, universal green CI, time saved, quality improvement, or causation.

The evidence supports the narrower claim: the PR machine was repeatedly used to carry reviewed Projects handoffs into owner-controlled draft PRs during the challenge extension work.
