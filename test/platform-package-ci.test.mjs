import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const jobIds = ['test', 'macos-smoke', 'codeql', 'handoff-semantics', 'ci-gate'];
const header = `name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read`;
const steps = node => `    steps:
      - uses: actions/checkout@PIN
        with:
          persist-credentials: false
      - uses: actions/setup-node@PIN
        with:
          node-version: ${node}
          cache: npm
      - run: npm ci --ignore-scripts
      - run: npm run check`;
const expectedJobs = {
  test: `  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [22, 24]
    runs-on: \${{ matrix.os }}
${steps('${{ matrix.node }}')}`,
  'macos-smoke': `  macos-smoke:
    runs-on: macos-latest
${steps('24')}`
};

// This is a deliberately closed contract for the checked-in layout, NOT a YAML
// parser or a GitHub policy evaluator. Unknown layouts fail and require review.
// Ignore blank/comment-only lines, trailing comments, and CRLF; retain indentation.
function linesOf(text) {
  assert.equal(typeof text, 'string');
  assert.ok(Buffer.byteLength(text) <= 65536);
  const normalized = text.replaceAll('\r\n', '\n');
  assert.doesNotMatch(normalized, /[\r\t]/u);
  return normalized.split('\n').map(line => line.replace(/\s+#.*$/u, '').trimEnd())
    .filter(line => line.trim() && !line.trimStart().startsWith('#'));
}

function assertPlatformPackageChecks(text, pkg) {
  const lines = linesOf(text);
  const jobsAt = lines.indexOf('jobs:');
  assert.ok(jobsAt > 0, 'one ordinary jobs mapping is required');
  assert.deepEqual(lines.slice(0, jobsAt), header.split('\n'), 'triggers and read-only defaults');
  assert.ok(lines.slice(jobsAt + 1).every(line => line.startsWith(' ')), 'no later root overrides');
  const starts = lines.flatMap((line, index) => {
    const match = /^  ([a-z][a-z0-9-]*):$/u.exec(line);
    return index > jobsAt && match ? [{ id: match[1], index }] : [];
  });
  assert.deepEqual(starts.map(item => item.id), jobIds, 'no missing, duplicate, or substituted jobs');
  for (const [id, expected] of Object.entries(expectedJobs)) {
    const offset = starts.findIndex(item => item.id === id);
    const block = lines.slice(starts[offset].index, starts[offset + 1].index).join('\n');
    // Permit reviewed action updates only when the reference is a full immutable
    // SHA. Do not mistake a tag, expression, or commented example for a pin.
    const pinned = block.replace(/^(      - uses: actions\/(?:checkout|setup-node))@[a-f0-9]{40}$/gmu, '$1@PIN');
    assert.equal(pinned, expected, `${id}: full package check with isolated checkout is required`);
  }
  assert.equal(pkg.scripts?.test, 'node --test test/*.test.mjs', 'complete Node suite');
  assert.equal(pkg.scripts?.check, 'npm test && npm run check:package', 'package check must run after successful tests');
  assert.equal(pkg.scripts?.['check:package'], 'node test/package-contract.mjs', 'real installed-package contract');
}

function changeJob(text, id, before, after) {
  const start = text.indexOf(`  ${id}:\n`);
  assert.ok(start >= 0);
  const end = text.indexOf(`  ${jobIds[jobIds.indexOf(id) + 1]}:\n`, start);
  assert.ok(end > start);
  const block = text.slice(start, end);
  assert.equal(block.split(before).length, 2, 'fixture must change exactly one target');
  return text.slice(0, start) + block.replace(before, after) + text.slice(end);
}

test('platform package CI: every supported job runs tests and the real installed contract', () => {
  assertPlatformPackageChecks(workflow, manifest);
});

test('platform package CI: CRLF, blank lines, and comments do not disable the contract', () => {
  const commented = workflow.replace('jobs:\n', '# job inventory\njobs: # required\n');
  assertPlatformPackageChecks(commented.replace(/\r?\n/gu, '\r\n'), manifest);
});

for (const id of ['test', 'macos-smoke']) {
  for (const [label, before, after] of [
    ['unit tests only', 'run: npm run check', 'run: npm test'],
    ['package tests only', 'run: npm run check', 'run: npm run check:package'],
    ['missing check', '      - run: npm run check\n', ''],
    ['masked failure', 'run: npm run check', 'run: npm run check || true'],
    ['conditional step', '      - run: npm run check', '      - if: false\n        run: npm run check'],
    ['error tolerance', '      - run: npm run check', '      - continue-on-error: true\n        run: npm run check'],
    ['install scripts enabled', 'npm ci --ignore-scripts', 'npm ci'],
    ['persisted credentials', 'persist-credentials: false', 'persist-credentials: true'],
    ['implicit credential default', '        with:\n          persist-credentials: false\n', ''],
    ['mutable checkout', /actions\/checkout@[a-f0-9]{40}/u, 'actions/checkout@main'],
    ['mutable Node setup', /actions\/setup-node@[a-f0-9]{40}/u, 'actions/setup-node@v7']
  ]) {
    test(`platform package CI: ${id} rejects ${label}`, () => {
      const changed = changeJob(workflow, id, before, after);
      assert.throws(() => assertPlatformPackageChecks(changed, manifest), assert.AssertionError);
    });
  }
}

for (const [label, id, before, after] of [
  ['missing Windows coverage', 'test', '[ubuntu-latest, windows-latest]', '[ubuntu-latest]'],
  ['missing Node 22 coverage', 'test', '[22, 24]', '[24]'],
  ['matrix exclusions', 'test', '        node: [22, 24]', '        node: [22, 24]\n        exclude: [{os: windows-latest, node: 22}]'],
  ['fail-fast cancellation', 'test', 'fail-fast: false', 'fail-fast: true'],
  ['non-macOS runner', 'macos-smoke', 'runs-on: macos-latest', 'runs-on: ubuntu-latest'],
  ['different macOS runtime', 'macos-smoke', 'node-version: 24', 'node-version: 20']
]) {
  test(`platform package CI: rejects ${label}`, () => {
    assert.throws(() => assertPlatformPackageChecks(changeJob(workflow, id, before, after), manifest), assert.AssertionError);
  });
}

for (const [label, text] of [
  ['privileged PR trigger', workflow.replace('  pull_request:', '  pull_request_target:')],
  ['write-capable default', workflow.replace('  contents: read', '  contents: write')],
  ['duplicate root jobs', `${workflow}\njobs: {}\n`],
  ['duplicate platform job', workflow.replace('  codeql:\n', '  macos-smoke:\n    runs-on: ubuntu-latest\n\n  codeql:\n')],
  ['unknown global defaults', workflow.replace('jobs:\n', 'defaults:\n  run:\n    shell: bash\njobs:\n')]
]) {
  test(`platform package CI: rejects ${label}`, () => {
    assert.throws(() => assertPlatformPackageChecks(text, manifest), assert.AssertionError);
  });
}

for (const [label, script, value] of [
  ['missing package chain', 'check', 'npm test'],
  ['masked unit failure', 'check', 'npm test; npm run check:package'],
  ['masked package failure', 'check', 'npm test && npm run check:package || true'],
  ['empty package contract', 'check:package', ''],
  ['fake package success', 'check:package', 'echo package contract passed'],
  ['narrowed test selection', 'test', 'node --test test/package-evidence.test.mjs']
]) {
  test(`platform package CI: rejects ${label}`, () => {
    const changed = { ...manifest, scripts: { ...manifest.scripts, [script]: value } };
    assert.throws(() => assertPlatformPackageChecks(workflow, changed), assert.AssertionError);
  });
}
