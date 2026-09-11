# Installed package verification (WP-07b / WP-07c)

`npm run check:package` now tests one real packed and locally installed artifact,
not only a source-tree import. It does not publish to npm, install globally,
update existing clients, or contact a hosted GitHub repository. The existing
package name, version, public API, and dependencies are unchanged. WP-07c extends
this existing contract to the macOS CI job as described below.
A launcher-bootstrap correction discovered by this contract is described below;
lifecycle logic and authority checks are unchanged.

## Reproduction

From a checkout with the supported Node, npm, and Git prerequisites:

```sh
node --test test/package-evidence.test.mjs test/cli-launcher.test.mjs
npm run check:package
npm run check
```

The first command exercises the package-verification helpers and CLI bootstrap. The second needs
npm's `npm_execpath` and runs the actual package contract. The third runs the
repository tests and then that contract. Linux/Windows Node 22/24 and macOS Node
24 jobs now run the complete contract. macOS Node 22 is not covered by this CI
configuration; no platform exclusion was added.

## Platform CI coverage (WP-07c)

The existing `macos-smoke` job retains its name and Node 24 runner but now runs
`npm run check`, not just `npm test`. The same installed-artifact, launcher,
lock-preservation, and ordinary-failure probes therefore run on all five platform
configurations. This is still a local offline installation on a hosted runner,
not authenticated end-to-end GitHub delivery or an update to an existing client.
The aggregate `CI gate` already depends on `macos-smoke`; its dependency list and
decision program are unchanged. A package failure must fail the platform job and
consequently the gate. Check names and branch-protection settings are not changed.

Both platform job definitions set checkout's `persist-credentials: false`
explicitly. This prevents checkout from retaining its authentication configuration
for subsequent test steps. It does not mean the runner is an operating-system
sandbox, that GitHub has no job token, or that hosted delivery is authorized.
Existing read-only workflow defaults and immutable action pins are preserved.

The dependency-free workflow regression suite can be run separately:

```sh
node --test test/platform-package-ci.test.mjs
```

It checks the actual platform job blocks and `package.json` script chain, not
just whether `npm run check` occurs somewhere in the workflow. Negative fixtures
cover dropped checks, conditional/error-tolerant steps, credential persistence,
mutable actions, reduced platform coverage, altered triggers/defaults, and fake
package success. Fixtures are compared as data; no substituted commands execute.
The existing gate suites continue to test aggregation and failure/skip behavior.

This intentionally recognizes the checked-in layout, not arbitrary YAML. CRLF,
blank lines, and comments are supported; other layout changes need an explicit
contract update and review. It is a regression tripwire, not an independent
security approval, branch-protection rule, or proof that the CI jobs ran. Actual
platform results and installed-package receipts must still be inspected for the
exact PR revision before making a verification claim.

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

## Launcher correction discovered by the contract

The first hosted run passed all 553 Node tests, then the Linux installed-launcher
assertion failed: `projects-pr --help` exited zero with empty output. The old
bootstrap compared the literal resolved `process.argv[1]` pathname with the ESM
module pathname. npm's Unix launcher is a symlink, so those pathnames differed
and the CLI never called `main`. This was a runtime defect, not a reason to remove
the package assertion or change its expected output.

The bootstrap now compares real paths. It retains import-only behavior when the
entry path is absent, unresolvable, or belongs to another module. Six regression
cases exercise direct help, a directory alias, aliased invalid-input receipts,
a different importing file with the same basename, and evaluation with absent or
unresolvable entry paths. Directory junctions permit the alias tests on Windows
without requiring file-symlink privileges. The installed npm launcher is still
checked separately in `check:package`.

Only the CLI's entry-point detection and filesystem import change. Its command
parser, `main`, lifecycle core, verification commands, lock/runner rules, and
owner approval requirements are unchanged. This correction is not yet an update
to any already installed or published client.

## Canonical temporary checkout paths

Windows CI passed all 559 Node tests at the launcher-fix revision, then refused
an installed `status` probe with `unsafe_repository` rather than `state_not_found`.
The temporary path from `os.tmpdir()` can contain an 8.3 short-name alias, while
Git returns a canonical long checkout path. The controller correctly requires its
specified repository to match the Git top level.

The test workspace is now canonicalized with `realpath` before deriving consumer,
artifact, or repository paths. A real directory-junction regression checks the
workspace helper on every platform, including two unique creations. The strict
`state_not_found` assertion, lock ownership assertions, and controller path rules
are unchanged. This fixes the fixture setup; it does not add production support
for arbitrary repository aliases.

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
- Node ESM resolved module filenames: https://nodejs.org/download/release/v22.14.0/docs/api/esm.html#importmetafilename
