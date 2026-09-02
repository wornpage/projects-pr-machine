# Source provenance

Wornpage PR Machine predates this public repository.

The initial public source was extracted on 2026-09-01 from the private Wornpage Projects production repository at commit `aaa7580ac2b8d057770d6d1947c99201c642ce29`, then reconciled with the actively installed stack-aware `projects-pack-delegation` controller last modified during the WebMCP challenge period on 2026-08-27.

The extraction includes:

- the `projects-pr` controller and its injected-effect tests;
- the Codex `projects-pack-delegation` plugin source and public protocol contracts;
- controller and hosted-service trust documentation;
- Wornpage-owned plugin artwork.

The standalone package, CI, security policy, public documentation, remote-base equality gate, and release artifacts were created for this public repository.

The MIT-licensed [`wornpage/projects-webmcp-extension`](https://github.com/wornpage/projects-webmcp-extension) repository contains no PR-machine source. Its `projects-pr/task-*` pull-request history is evidence that this separate AGPL tool was used in that development workflow; it does not transfer code or change either repository's license.
