# Invocation-time lifecycle inputs (WP-05b)

The seven mutating public library functions capture their supported input fields
before asynchronous repository discovery: `prepareProjectsPr`, `finalizeProjectsPr`,
`abortProjectsPr`, `stackProjectsPr`, `authorizeProjectsPr`,
`authorizeAdminProjectsPr`, and `finishProjectsPr`. CLI mutations use this same
boundary. Public command names, package exports, and CLI grammar are unchanged.

## Why capture is necessary

The repository lock must cover the repository actually operated on. Previously,
most public mutations retained the caller's input object while discovering and
acquiring that lock. Changing `input.repositoryRoot` or `input.packId` during an
await could redirect core to another checkout or pack after the first checkout
was locked. Authorization also reads confirmation and admin fields after awaits;
those fields must belong to the same invocation, not a later object mutation.
WP-02c already captured prepare's plan; this extends the binding to every
mutation and its contention/recovery receipt.

The facade now captures consumed fields and copies ordered `packIds` and
`bypassedRequirements` arrays. It resolves a relative or omitted repository root
against the invocation-time working directory and supplies that same absolute
root to both lock discovery and core. Changing the caller object, array contents,
or process working directory later does not change the running operation.

`confirmOwner: false` and `confirmReview: false` remain false even if the caller
later assigns true. Missing and non-boolean confirmations are not promoted to
approval. Supply a new invocation only after obtaining the required review and
owner decision; input capture is not independent authentication of that decision.
Likewise, changing an original true value later is not a cancellation API. Stop
and reconcile an in-flight operation through the existing recovery process.

## Library input compatibility

Mutating inputs must be ordinary objects (or null-prototype records) whose
consumed fields are own data properties containing primitive values. Ordered
list fields are copied from own, primitive-valued entries. Accessors, inherited
inputs, mutable scalar objects/functions, and sparse/accessor/reference-valued
array entries fail with a bounded `ProjectsPrError` / `invalid_input` before
repository I/O. Unused fields are ignored without evaluating their getters.
This deliberately narrows unusual library-object usage; CLI inputs already use
ordinary strings, booleans, and dense arrays. Materialize values before calling.

Capture does not normalize primitive input, sort lists, or manufacture defaults
other than the existing repository-root resolution. Existing command validators
still decide permitted values, exact booleans, command limits, and policy.
Prepare's canonical 1-500-code-point verification rule remains in force; the
pure public plan function and legacy core/state parsing are otherwise unchanged.
No saved state or command hash is migrated or rewritten.

The trusted dependency record is copied before the first await as well. Replacing
its `fs`, `runner`, `now`, or other property cannot replace that invocation's
chosen dependency. Referenced implementations and their internal state are not
deep-cloned or frozen: a filesystem object remains a functioning filesystem.
This is consistency protection for ordinary in-process callers, not a sandbox
against proxies, global prototype changes, hostile injected dependencies, direct
Git commands, or same-user filesystem mutation. Read-only `doctor` and `status`
remain unchanged and lock-free.

## Verification

```sh
node --test test/mutation-input.test.mjs
node --test test/projects-pr-input.test.mjs
npm run check
```

The pure suite checks every supported field, array isolation, exact primitive
preservation, refusal without accessor/coercion calls, and bounded diagnostics.
Public-entry cases use actual controller/lock code and disposable filesystem
fixtures with explicitly simulated Git observations to test all seven entries,
contention receipts, dependency replacement, and working-directory changes.
Additional cases reuse real local Git/worktree preparation, safe abort, and
completed draft fixtures. They demonstrate preservation of the untouched second
checkout and refusal to acquire owner/review confirmation mid-call. Their GitHub
responses are a strict local stand-in; no hosted repository is mutated.

These tests do not establish independent review, hosted acceptance, production
release, cancellation, or remote rollback. Lock release/uncertainty rules,
deadlines, exact-head checks, and owner-controlled delivery remain unchanged.
