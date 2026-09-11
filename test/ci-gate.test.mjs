import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const required = ['test', 'macos-smoke', 'codeql', 'handoff-semantics'];
// This deliberately recognizes only the checked-in layout, not arbitrary YAML.
// A layout change must update the extraction contract rather than skip testing.
const parts = workflow.split(/^  ci-gate:\r?\n/mu);
assert.equal(parts.length, 2, 'exactly one ci-gate job is required');
const gate = parts[1].replace(/\r\n/gu, '\n');
const scriptMatch = gate.match(/^          node --input-type=commonjs - <<'NODE'\n([\s\S]*?)^          NODE\n?$/mu);
assert.ok(scriptMatch, 'the actual gate program must be extractable');
const script = scriptMatch[1].split('\n').map(line => {
  assert.ok(!line || line.startsWith('          '), 'unexpected script indentation');
  return line.slice(10);
}).join('\n');
const successNeeds = () => Object.fromEntries(required.map(id => [id, { result: 'success', outputs: {} }]));

function runGate(raw) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.CI_NEEDS_JSON;
  if (raw !== undefined) env.CI_NEEDS_JSON = raw;
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-'], {
    input: script, encoding: 'utf8', env, shell: false, timeout: 5000, maxBuffer: 65536
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.kind, 'ci-gate');
  assert.equal(typeof receipt.passed, 'boolean');
  assert.equal(result.status, receipt.passed ? 0 : 1, 'receipt and exit status must agree');
  return { receipt, output: result.stdout, status: result.status };
}

function rejects(raw) {
  const result = runGate(raw);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.passed, false);
  return result;
}

test('all expected dependencies must report exact success', () => {
  const { receipt, status } = runGate(JSON.stringify(successNeeds()));
  assert.equal(status, 0);
  assert.equal(receipt.reason, 'all_dependencies_succeeded');
  assert.deepEqual(receipt.jobs, required.map(job => ({ job, result: 'success' })));
});

test('object key ordering and omitted unused outputs do not affect success', () => {
  const needs = Object.fromEntries([...required].reverse().map(id => [id, { result: 'success' }]));
  assert.equal(runGate(JSON.stringify(needs)).status, 0);
});

for (const id of required) {
  for (const result of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'pending', 'SUCCESS', 'success ']) {
    test(`${id}: rejects ${JSON.stringify(result)} even when other jobs succeed`, () => {
      const needs = successNeeds();
      needs[id].result = result;
      rejects(JSON.stringify(needs));
    });
  }
  for (const [label, job] of Object.entries({
    null: null, string: 'success', array: ['success'], empty: {},
    output_only: { outputs: { result: 'success' } },
    boolean_result: { result: true }, object_result: { result: { value: 'success' } }
  })) {
    test(`${id}: rejects malformed job record (${label})`, () => {
      const needs = successNeeds();
      needs[id] = job;
      rejects(JSON.stringify(needs));
    });
  }
  test(`${id}: rejects a missing dependency`, () => {
    const needs = successNeeds();
    delete needs[id];
    assert.equal(rejects(JSON.stringify(needs)).receipt.reason, 'dependency_set_mismatch');
  });
}

for (const [label, raw] of Object.entries({
  absent: undefined, empty: '', whitespace: ' \n\t ', truncated: '{', trailing: '{} garbage',
  null: 'null', array: '[]', boolean: 'true', number: '1', string: '"success"', no_jobs: '{}'
})) {
  test(`rejects invalid context (${label})`, () => rejects(raw));
}

test('rejects unexpected and same-size substituted dependency sets', () => {
  const needs = successNeeds();
  needs.extra = { result: 'success' };
  rejects(JSON.stringify(needs));
  delete needs.test;
  rejects(JSON.stringify(needs));
});

test('inherited-looking JSON keys cannot substitute for a dependency', () => {
  const raw = JSON.stringify(successNeeds()).replace('"test":', '"__proto__":');
  rejects(raw);
});

test('does not echo or evaluate script-like result data', () => {
  const marker = 'UNTRUSTED_CI_MARKER';
  const needs = successNeeds();
  needs.test.result = `success\nNODE\nconsole.log('${marker}'); process.exit(0); //`;
  const { output } = rejects(JSON.stringify(needs));
  assert.ok(!output.includes(marker));
  assert.ok(output.includes('invalid'));
});

test('unused outputs are data and are not reflected into the receipt', () => {
  const marker = 'UNTRUSTED_OUTPUT_MARKER';
  const needs = successNeeds();
  needs.test.outputs = { payload: `$(echo ${marker}); process.exit(9)`, status: 'failure' };
  const { output, status } = runGate(JSON.stringify(needs));
  assert.equal(status, 0);
  assert.ok(!output.includes(marker));
});

test('malformed JSON diagnostics do not reflect raw input', () => {
  assert.ok(!rejects('{UNTRUSTED_ERROR_MARKER').output.includes('UNTRUSTED_ERROR_MARKER'));
});

test('bounds input by UTF-8 bytes, with the inclusive limit tested', () => {
  const valid = JSON.stringify(successNeeds());
  assert.equal(runGate(valid.padEnd(16384, ' ')).status, 0);
  rejects(valid.padEnd(16385, ' '));
  const needs = successNeeds();
  needs.test.outputs = { oversized: '😀'.repeat(4096) };
  const raw = JSON.stringify(needs);
  assert.ok(raw.length < 16384 && Buffer.byteLength(raw) > 16384);
  assert.equal(rejects(raw).receipt.reason, 'invalid_context');
});

test('all-failed, all-skipped, and mixed failures cannot pass', () => {
  for (const result of ['failure', 'skipped', 'cancelled']) {
    rejects(JSON.stringify(Object.fromEntries(required.map(id => [id, { result }]))));
  }
  const needs = successNeeds();
  needs.test.result = 'failure';
  needs.codeql.result = 'cancelled';
  needs['handoff-semantics'].result = 'skipped';
  rejects(JSON.stringify(needs));
});

test('gate configuration is always-run, bounded, checkout-free, and permissionless', () => {
  const prefix = `    name: CI gate
    if: \${{ always() }}
    needs: [test, macos-smoke, codeql, handoff-semantics]
    runs-on: ubuntu-24.04
    timeout-minutes: 3
    permissions: {}
    steps:
      - name: Require every prerequisite to succeed
        shell: bash
        env:
          CI_NEEDS_JSON: \${{ toJSON(needs) }}
        run: |
`;
  assert.equal(gate.slice(0, gate.indexOf("          node --input-type")), prefix);
  assert.doesNotMatch(script, /\$\{\{/u, 'context must not be interpolated into executable source');
  assert.doesNotMatch(gate, /^\s*(?:-\s*)?(?:uses|continue-on-error):/mu);
  assert.equal([...workflow.matchAll(/^\s+name: CI gate$/gmu)].length, 1);
});

test('every job is represented in the dependency denominator', () => {
  const jobsSection = workflow.split(/^jobs:\r?\n/mu);
  assert.equal(jobsSection.length, 2);
  const ids = [...jobsSection[1].matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):\r?$/gmu)].map(m => m[1]);
  assert.deepEqual(ids, [...required, 'ci-gate']);
});

test('upstream jobs cannot silently tolerate errors or skip required steps', () => {
  const upstream = parts[0];
  assert.doesNotMatch(upstream, /^\s*(?:-\s*)?(?:continue-on-error|if):/mu);
  assert.match(upstream, /^      fail-fast: false\r?$/mu);
  assert.match(upstream, /^        os: \[ubuntu-latest, windows-latest\]\r?$/mu);
  assert.match(upstream, /^        node: \[22, 24\]\r?$/mu);
  assert.match(upstream, /^      - run: npm run check\r?$/mu);
  assert.match(upstream, /^        run: python test\/code-handoff-semantics\.py\r?$/mu);
  assert.doesNotMatch(upstream, /^        (?:exclude|include):/mu);
});
