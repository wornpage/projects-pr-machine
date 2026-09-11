# Handoff semantic regression tests (WP-02b)

Tests for the [code-handoff acceptance profile](code-handoff-acceptance.md).

The `handoff-semantics` CI job exercises actual payloads with python-jsonschema
4.26.0 and the real JavaScript builder. It checks the baseline plus four generated
Draft 2020-12 schemas, compares baseline/profile acceptance, and verifies that
negative fixtures detect seven deliberate in-memory schema weakenings. Each
payload is checked for unintended mutation. The output reports actual case
counts; any mismatch, invalid schema, missing dependency, or builder error fails
the process. External schema retrieval is disabled during payload validation.

This job is separate from `npm run check`, which remains unchanged. The existing
Node matrix, macOS tests, and CodeQL job still run. No Python package becomes an
npm/runtime dependency, and no production code is modified by these tests.

To reproduce on glibc Linux x86-64 with CPython 3.11 or 3.12 and Node >=22:

```sh
python3 -m venv /tmp/projects-handoff-tests
/tmp/projects-handoff-tests/bin/python -m pip install --require-hashes --only-binary=:all: -r test/requirements-handoff.txt
/tmp/projects-handoff-tests/bin/python test/code-handoff-semantics.py
node --test test/code-handoff-acceptance.test.mjs
```

The test lock includes reviewed PyPI wheel hashes for those Python/Linux
combinations, not every platform. CI uses Python 3.12 and Node 24. Refresh all
pins and relevant wheel hashes together; do not disable hash checks or fall back
to source builds. No format extras are installed or claimed. The suite tests the
patterns and validation keywords actually present in v1, not calendar validity
or a complete cross-validator conformance matrix.

All reports are synthetic. The fixed Node subprocess only builds schemas; it
never evaluates any `tests[].command`. Passing this job is not worker test
execution, independent review, evidence authentication, SHA binding, or hosted
acceptance. Repository administrators must separately decide whether to require
this named check; adding a CI job does not change branch protection. The private
service must still enforce validation and authorization before accepting work.
