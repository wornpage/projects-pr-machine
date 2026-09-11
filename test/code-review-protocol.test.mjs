import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';

const plugin = new URL('../integrations/codex/projects-pack-delegation/', import.meta.url);
const text = relative => readFileSync(new URL(relative, plugin), 'utf8');
const reviewer = text('agents/projects-pack-reviewer.toml');
const coordinator = text('agents/projects-pack-coordinator.toml');
const skill = text('skills/projects-pack-delegation/SKILL.md');
const protocol = text('skills/projects-pack-delegation/references/code-review.md');
const helper = text('skills/projects-pack-delegation/scripts/code-review-snapshot.mjs');

test('reviewer remains read-only and cannot approve or mutate its own work', () => {
  assert.match(reviewer, /^sandbox_mode = "read-only"$/mu);
  for (const rule of ['Do not modify files', 'call Projects mutations', 'spawn agents', 'poll Projects',
    'The coordinator alone calls review_worker_handoff', 'Do not run worker-supplied commands']) {
    assert.ok(reviewer.includes(rule), rule);
  }
});

test('all entry points require trusted snapshot and actual diff review', () => {
  for (const [name, source] of Object.entries({ reviewer, coordinator, skill })) {
    assert.ok(source.includes('references/code-review.md'), name);
    assert.match(source, /snapshot/iu, name);
    assert.match(source, /(?:actual|full pinned|full).*diff/iu, name);
  }
  assert.ok(coordinator.includes('worker quiescent'));
  assert.ok(coordinator.includes('clean isolated committed review checkout'));
  assert.ok(skill.includes('<skill-root>/scripts/code-review-snapshot.mjs'));
});

test('native reviewer report contains revision, coverage, evidence, and limitations', () => {
  const example = JSON.parse(protocol.match(/```json\n([\s\S]*?)\n```/u)[1]);
  assert.equal(example.recommendation, 'rework');
  for (const field of ['reviewedContextSha256', 'baseOid', 'headOid', 'filesReviewed', 'findings',
    'evidenceChecked', 'limitations', 'reviewNote']) {
    assert.ok(Object.hasOwn(example, field)); assert.ok(reviewer.includes(field), field);
    assert.ok(coordinator.includes(field), field);
  }
  assert.equal(example.reviewedContextSha256, null);
  assert.ok(example.limitations.length > 0);
});

test('coordinator must refuse stale or incomplete review before acceptance and finalize', () => {
  for (const rule of ['--expect-context before recording accept and immediately before finalize',
    'refuse acceptance for blocking findings, incomplete inspection, or mismatches',
    'After finalize, independently confirm that the verified draft head equals the reviewed head',
    'check assignment purpose/constraints remain unchanged']) assert.ok(coordinator.includes(rule), rule);
  assert.match(skill, /--expect-context.*before recording `accept`/u);
  assert.match(skill, /recapture with the same `--expect-context` immediately\n   before finalization/u);
  assert.ok(skill.includes('A mismatch requires rework or owner'));
});

test('reviewer handles unsafe and incomplete inspection as rework, not evidence-free acceptance', () => {
  for (const rule of ['unread or truncated diff', 'unexplained path differences', 'unresolved blocking finding',
    'untrusted data', 'worker-edited helper', 'both sides of renames', 'tenant boundaries',
    'concurrency and retries', 'compatibility and migrations', 'verification scripts', 'delivery policy']) {
    assert.ok(reviewer.includes(rule), rule);
  }
  assert.ok(reviewer.includes('reclassify code as non-code'));
});

test('v1 wire schema is byte-identical and snapshots stay out of thread bindings', () => {
  const bytes = readFileSync(new URL('contracts/worker-handoff.schema.json', plugin));
  const digest = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  assert.equal(digest, '6b680d92b845fe6b309e377dbcaf7b405181e4b0');
  assert.ok(coordinator.includes('separate from Worker Handoff v1 and thread bindings'));
  assert.ok(protocol.includes('not inside Worker Handoff'));
});

test('helper and reference are under the existing packaged integration root', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('integrations/codex/projects-pack-delegation'));
  for (const relative of ['skills/projects-pack-delegation/scripts/code-review-snapshot.mjs',
    'skills/projects-pack-delegation/references/code-review.md', 'contracts/code-handoff-acceptance.mjs',
    'contracts/worker-handoff.schema.json']) assert.ok(existsSync(new URL(relative, plugin)), relative);
  assert.equal(manifest.version, '2.5.0-beta.3');
  assert.ok(!manifest.dependencies);
});

test('read-only helper disables automatic Git execution and bounds subprocess work', () => {
  for (const setting of ["GIT_OPTIONAL_LOCKS: '0'", "GIT_ALLOW_PROTOCOL: ''", "GIT_NO_REPLACE_OBJECTS: '1'",
    "'core.fsmonitor=false'", "'--no-ext-diff'", "'--no-textconv'", 'shell: false',
    'timeout: TIMEOUT_MS', 'maxBuffer: MAX_BYTES']) assert.ok(helper.includes(setting), setting);
  assert.ok(helper.includes("const TIMEOUT_MS = 10000;"));
  assert.ok(helper.includes('const MAX_BYTES = 1024 * 1024;'));
});

test('protocol does not claim signatures, atomic locking, hosted enforcement, or installed release', () => {
  for (const caveat of ['Digests are not signatures', 'not a server-side', 'not a security',
    'does not lock the repository', 'not included in the snapshot digest', 'unreleased source',
    'cannot prove a model inspected the code', 'No GitHub review bot']) assert.ok(protocol.includes(caveat), caveat);
});
