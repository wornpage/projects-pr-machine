import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const load = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const workflow = load('../.github/workflows/ci-gate-rehearsal.yml');
const production = load('../.github/workflows/ci.yml');
const ids = ['test', 'macos-smoke', 'codeql', 'handoff-semantics', 'ci-gate'];
const modes = ['success', 'failure', 'skipped', 'mixed'];

// Deliberately recognize only the checked-in layout, not arbitrary YAML.
function program(source, delimiter) {
  const start = `          node --input-type=commonjs - <<'${delimiter}'\n`;
  const pieces = source.split(start);
  assert.equal(pieces.length, 2, 'one matching heredoc is required');
  const rest = pieces[1].split(`          ${delimiter}\n`);
  assert.equal(rest.length, 2, 'one closing delimiter is required');
  return rest[0].split('\n').map(line => {
    assert.ok(!line || line.startsWith('          '), 'unexpected indentation');
    return line.slice(10);
  }).join('\n');
}
const gate = program(workflow, 'NODE');
const report = program(workflow, 'REPORT');
function execute(script, variables) {
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'CI_NEEDS_JSON', 'REHEARSAL_NEEDS_JSON', 'REHEARSAL_SCENARIO']) delete env[name];
  for (const [name, value] of Object.entries(variables)) if (value !== undefined) env[name] = value;
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-'], {
    input: script, encoding: 'utf8', env, shell: false, timeout: 5000, maxBuffer: 65536
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  const passed = receipt.kind === 'ci-gate' ? receipt.passed : receipt.matched;
  assert.equal(typeof passed, 'boolean');
  assert.equal(result.status, passed ? 0 : 1);
  return { status: result.status, receipt, output: result.stdout };
}
function expected(mode) {
  return Object.fromEntries(ids.map(id => [id, { result:
    id === 'test' && ['failure', 'mixed'].includes(mode) ? 'failure' :
    id === 'macos-smoke' && ['skipped', 'mixed'].includes(mode) ? 'skipped' :
    id === 'ci-gate' && mode !== 'success' ? 'failure' : 'success', outputs: {} }]));
}
const observe = (mode, raw) => execute(report, { REHEARSAL_SCENARIO: mode, REHEARSAL_NEEDS_JSON: raw });

test('rehearsal executes the production gate decision program without edits', () => {
  assert.equal(gate, program(production + '\n', 'NODE'));
});

test('final rehearsal is manual-only and defaults to the successful control', () => {
  const trigger = workflow.split(/^on:\n/mu)[1].split(/^permissions:/mu)[0];
  assert.equal(trigger, `  workflow_dispatch:
    inputs:
      scenario:
        description: 'Fixture outcome (negative scenarios intentionally make this run red)'
        required: true
        default: success
        type: choice
        options: [success, failure, skipped, mixed]

`);
  assert.match(workflow, /^  REHEARSAL_SCENARIO: \$\{\{ inputs\.scenario \|\| 'success' \}\}$/mu);
});

test('fixture jobs have no checkout, installs, write permissions, or error tolerance', () => {
  assert.match(workflow, /^permissions: \{\}$/mu);
  assert.doesNotMatch(workflow, /^\s*(?:-\s*)?(?:uses|continue-on-error|environment|container|services):/mu);
  assert.doesNotMatch(workflow, /secrets\.|github\.token|npm |pip |curl |wget |git /u);
  assert.equal([...workflow.matchAll(/^    runs-on: ubuntu-24\.04$/gmu)].length, 6);
  assert.equal([...workflow.matchAll(/^    timeout-minutes: [23]$/gmu)].length, 6);
  assert.equal([...workflow.matchAll(/^[ \t]+permissions:/gmu)].length, 1);
  assert.match(workflow, /^    permissions: \{\}$/mu);
  assert.doesNotMatch(workflow, /^    name: CI gate$/mu, 'rehearsal must not supply the production check name');
  assert.doesNotMatch(gate + report, /\$\{\{/u, 'context must be passed as data');
});

test('gate and observer wait for the exact expected dependencies even after failure or skip', () => {
  assert.deepEqual([...workflow.matchAll(/^  ([a-z][a-z-]*):$/gmu)].map(m => m[1]).filter(id => id !== 'workflow_dispatch'), [...ids, 'rehearsal-report']);
  assert.match(workflow, /  ci-gate:\n    name: Rehearsal gate\n    if: \$\{\{ always\(\) \}\}\n    needs: \[test, macos-smoke, codeql, handoff-semantics\]/u);
  assert.match(workflow, /  rehearsal-report:\n    name: Rehearsal observation\n    if: \$\{\{ always\(\) \}\}\n    needs: \[test, macos-smoke, codeql, handoff-semantics, ci-gate\]/u);
  assert.match(workflow, /      fail-fast: false\n      matrix:\n        cell: \[control, probe\]/u);
  assert.match(workflow, /    if: \$\{\{ \(inputs\.scenario \|\| 'success'\) != 'skipped' && \(inputs\.scenario \|\| 'success'\) != 'mixed' \}\}/u);
});

for (const mode of modes) {
  test(`${mode}: actual gate result and observer agree with the scenario`, () => {
    const needs = expected(mode);
    const actualGate = execute(gate, { CI_NEEDS_JSON: JSON.stringify(Object.fromEntries(ids.slice(0, -1).map(id => [id, needs[id]]))) });
    assert.equal(actualGate.status, mode === 'success' ? 0 : 1);
    assert.equal(observe(mode, JSON.stringify(needs)).status, 0);
  });
  for (const id of ids) {
    test(`${mode}: observer rejects an unexpected result for ${id}`, () => {
      const needs = expected(mode);
      needs[id].result = needs[id].result === 'success' ? 'failure' : 'success';
      assert.equal(observe(mode, JSON.stringify(needs)).status, 1);
    });
  }
}
for (const [label, raw] of Object.entries({ absent: undefined, empty: '', null: 'null', array: '[]', malformed: '{', emptyObject: '{}', tooLarge: ' '.repeat(16385) })) {
  test(`observer rejects ${label} context`, () => assert.equal(observe('mixed', raw).status, 1));
}
for (const mode of [undefined, '', 'MIXED', 'invalid']) {
  test(`observer rejects invalid scenario ${String(mode)}`, () => assert.equal(observe(mode, JSON.stringify(expected('mixed'))).status, 1));
}
test('observer rejects missing, unexpected, and malformed dependency records', () => {
  for (const id of ids) {
    const needs = expected('mixed');
    delete needs[id];
    assert.equal(observe('mixed', JSON.stringify(needs)).status, 1);
    needs[id] = ['failure'];
    assert.equal(observe('mixed', JSON.stringify(needs)).status, 1);
  }
  const needs = expected('mixed');
  needs.extra = { result: 'success' };
  assert.equal(observe('mixed', JSON.stringify(needs)).status, 1);
});
test('observer neither evaluates nor reflects arbitrary context data', () => {
  const marker = 'REHEARSAL_UNTRUSTED_MARKER';
  const needs = expected('mixed');
  needs.test.result = `failure\nREPORT\nconsole.log('${marker}'); process.exit(0);`;
  const result = observe('mixed', JSON.stringify(needs));
  assert.equal(result.status, 1);
  assert.ok(!result.output.includes(marker));
  const control = expected('mixed');
  control.test.outputs = { ignored: marker };
  assert.ok(!observe('mixed', JSON.stringify(control)).output.includes(marker));
});
