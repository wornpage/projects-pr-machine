# Installed package verification (WP-07b)

`npm run check:package` now tests one real packed and locally installed artifact,
not only a source-tree import. It does not publish to npm, install globally,
update existing clients, or contact a hosted GitHub repository. The existing
package name, version, public API, controller, dependencies, and CI selection
are unchanged.

## Reproduction

From a checkout with the supported Node, npm, and Git prerequisites:

```sh
node --test test/package-evidence.test.mjs
npm run check:package
npm run check
```

The first command exercises the package-verification helpers. The second needs
npm's `npm_execpath` and runs the actual package contract. The third runs the
repository tests and then that contract. Existing Linux/Windows Node 22/24 jobs
run the complete contract; macOS's existing `npm test` runs the helper tests, not
the full installed-package contract. No platform exclusion was added.

## Artifact continuity

The contract packs once, with JSON metadata, into a newly created temporary
artifact directory outside the source checkout. It validates the exact package
identity and public entry points, the expected tarball filename, unique canonical
file paths, and required controller/lock/runner/review assets. Test directories,
Git metadata, dependency directories, root npm configuration, and nested tarballs
are not accepted in the packed inventory. The current zero-runtime-dependency
contract is explicit; new dependencies require a deliberate contract revision.

Actual tarball bytes must match the reported length, SHA-1, and SHA-512 integrity.
A SHA-256 is also recorded. After installing that exact local tarball, the
installed inventory must match the packed inventory and every installed file
must match the captured source bytes. Links within the package are refused.

There is one narrow byte exception: npm's bin-links may remove the CR from a
CRLF executable shebang. Only that single byte in the declared CLI is permitted
to change. Other line endings and all remaining bytes stay exact, including
non-UTF-8 bytes. Tests reject broad line-ending normalization or body rewriting.
This exception is reported, not silently hidden.

The success evidence identifies the package, Node version, source checkout
commit, source-dirty flag, tarball hashes, file count, digest of the sorted
per-file source/installed SHA-256 records, normalization paths, and probe counts.
The checkout commit alone is not proof of clean source: inspect `sourceDirty`.
Hashes are local measurements, not signed provenance, reviewer authentication,
or proof that the same artifact is published or deployed. Temporary artifacts
are removed after ordinary completion/failure; the log retains their identity.

## Installed behavior, without controller runner injection

Fresh Node processes execute the installed canonical CLI. The npm-created Unix
launcher or Windows `.cmd` launcher is also invoked. The contract retains the
previous help, delivery-input, and package-import checks, and expands them to:

- All nine command help pages, root help, seventeen invalid-input cases, and
  eleven CLI/library exports.
- All seven mutating CLI commands and all seven public mutating functions
  refusing an existing lock with `operationOutcome: not_started`.
- A lock-free `status` read reporting missing state while preserving the lock.
- Two fresh `finalize` attempts without state, each failing normally and
  releasing only its own invocation lock so the next attempt can proceed.

Those lock probes use a disposable real Git repository with no commits, remote,
or lifecycle state. The original synthetic lock's bytes and file/directory
identities must survive contention. The fixture removes its own synthetic lock
before the ordinary-failure probes; that is not a production unlock procedure.
The repository config, branch, and lack of worktree effects are checked afterward.
No verification command, real `gh` executable, merge, or remote deletion runs.

The test harness uses the source bounded subprocess runner with a trusted spawn
adapter to select the current Node and a reduced child environment. It does not
inject dependencies into the installed controller. npm commands use offline mode,
disabled lifecycle scripts/audit/funding, an isolated cache, and empty user/global
configuration files. Inherited token variables, Node injection options, Git
redirection, proxies, and SSH-agent settings are not forwarded. Git transport is
disabled for these local-only probes. Local tools and their search path remain
trusted; this is not an OS sandbox for arbitrary source, npm, or same-user activity.

Every subprocess invocation has a 30-second deadline and the existing 1 MiB
per-stream limit. An uncertain result stops subsequent probes and retains the
test directory rather than guessing that descendants are quiescent. Inspect the
reported temporary directory and relevant test-owned processes before removal.
Ordinary assertion/command failures clean up the test's own temporary directory.

## Remaining boundaries

WP-07a's full draft-lifecycle rehearsal and WP-06b's interruption tests remain
separate and intact. This increment does not exercise authenticated GitHub
permissions, hosted API response loss, branch protection, independent review,
private acceptance transitions, optional merge authority, registry publication,
or installed-client upgrade/rollback. Package integrity cannot prove the code's
business correctness. Hosted end-to-end work still needs an explicitly authorized
disposable target and appropriate credentials.

## Tool behavior references

- npm pack destination and metadata: https://docs.npmjs.com/cli/v10/commands/npm-pack/
- npm offline/configuration and script controls: https://docs.npmjs.com/cli/v10/using-npm/config/
- npm local tarball installation: https://docs.npmjs.com/cli/v10/commands/npm-install/
- npm executable-shebang normalization: https://github.com/npm/bin-links/blob/main/lib/fix-bin.js
