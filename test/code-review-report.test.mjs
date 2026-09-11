import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCodeReviewReport, readReviewInput, MAX_REVIEW_BYTES }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/code-review-report.mjs';
import { createCodeReviewSnapshot }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/code-review-snapshot.mjs';

const script = fileURLToPath(new URL('../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/code-review-report.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const base = 'a'.repeat(40), head = 'b'.repeat(40), context = 'c'.repeat(64);
function envelope() {
  return {
    assignment: { repositoryRoot: path.resolve(tmpdir(), 'review-report'), baseOid: base, headOid: head,
      packId: 'pack-1', workerId: 'worker-1', verificationCommand: 'npm run check', expectedContextSha256: context },
    report: { recommendation: 'accept', reviewedContextSha256: context, baseOid: base, headOid: head,
      filesReviewed: ['src/app.mjs', 'old.txt'], findings: [],
      evidenceChecked: [{ origin: 'independently-observed', description: 'Inspected the pinned diff and surrounding code.' }],
      limitations: [], reviewNote: 'Full changed-path coverage; no blocking findings.' }
  };
}
const snapshot = assignment => ({ kind: 'code-review-snapshot', schemaVersion: 1,
  ...assignment, contextSha256: assignment.expectedContextSha256,
  verificationCommandSha256: hash(assignment.verificationCommand),
  files: [{ status: 'M', path: 'src/app.mjs' }, { status: 'D', path: 'old.txt' }] });
const capture = async assignment => snapshot(assignment);
const check = input => checkCodeReviewReport(JSON.stringify(input), { capture });
const refuses = (promise, code) => assert.rejects(promise, error => error.code === code && !error.message.includes('PRIVATE_MARKER'));

test('checks exact reviewed context, recaptures once, and emits a bounded validation receipt', async () => {
  const input = envelope(); let calls = 0;
  const result = await checkCodeReviewReport(JSON.stringify(input), { capture: async assignment => {
    calls++; assert.deepEqual(assignment, input.assignment); return snapshot(assignment);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { kind: 'code-review-report-check', schemaVersion: 1, status: 'validated',
    baseOid: base, headOid: head, contextSha256: context, reportSha256: hash(JSON.stringify(input.report)),
    filesReviewed: 2, findings: 0, evidenceItems: 1 });
  assert.ok(!JSON.stringify(result).includes(input.assignment.repositoryRoot));
  assert.ok(!JSON.stringify(result).includes('npm run check'));
  assert.ok(!JSON.stringify(result).includes(input.report.reviewNote));
});

test('coverage order is irrelevant, but the receipt identifies the exact parsed report', async () => {
  const first = envelope(); const second = envelope(); second.report.filesReviewed.reverse();
  const a = await check(first), b = await check(second);
  assert.equal(a.contextSha256, b.contextSha256); assert.notEqual(a.reportSha256, b.reportSha256);
});

for (const [label, mutate, code] of [
  ['missing envelope', () => null, 'invalid_envelope'],
  ['array envelope', () => [], 'invalid_envelope'],
  ['extra envelope field', v => { v.capture = 'PRIVATE_MARKER'; }, 'invalid_envelope'],
  ['missing assignment', v => { delete v.assignment; }, 'invalid_envelope'],
  ['missing report', v => { delete v.report; }, 'invalid_envelope'],
  ['extra assignment field', v => { v.assignment.runner = 'PRIVATE_MARKER'; }, 'invalid_assignment'],
  ['missing original digest', v => { delete v.assignment.expectedContextSha256; }, 'invalid_assignment'],
  ['relative checkout', v => { v.assignment.repositoryRoot = '.'; }, 'invalid_assignment'],
  ['branch as base', v => { v.assignment.baseOid = 'main'; }, 'invalid_assignment'],
  ['abbreviated head', v => { v.assignment.headOid = 'abc'; }, 'invalid_assignment'],
  ['mixed OID formats', v => { v.assignment.headOid = 'b'.repeat(64); }, 'invalid_assignment'],
  ['uppercase digest', v => { v.assignment.expectedContextSha256 = 'C'.repeat(64); }, 'invalid_assignment'],
  ['null command', v => { v.assignment.verificationCommand = null; }, 'invalid_assignment'],
  ['oversized v1 command', v => { v.assignment.verificationCommand = 'x'.repeat(501); }, 'invalid_assignment'],
  ['noncanonical command', v => { v.assignment.verificationCommand = 'npm test\n'; }, 'invalid_assignment'],
  ['unpaired command surrogate', v => { v.assignment.verificationCommand = '\ud800'; }, 'invalid_assignment'],
  ['wrong worker type', v => { v.assignment.workerId = 1; }, 'invalid_assignment'],
  ['extra report field', v => { v.report.approved = true; }, 'invalid_report'],
  ['missing review note', v => { delete v.report.reviewNote; }, 'invalid_report'],
  ['blank review note', v => { v.report.reviewNote = ' \t\n'; }, 'invalid_report'],
  ['unpaired report surrogate', v => { v.report.reviewNote = '\ud800'; }, 'invalid_report'],
  ['unknown recommendation', v => { v.report.recommendation = 'approved'; }, 'invalid_recommendation'],
  ['rework recommendation', v => { v.report.recommendation = 'rework'; }, 'review_requires_rework'],
  ['wrong base', v => { v.report.baseOid = 'd'.repeat(40); }, 'review_context_mismatch'],
  ['wrong head', v => { v.report.headOid = 'd'.repeat(40); }, 'review_context_mismatch'],
  ['wrong context', v => { v.report.reviewedContextSha256 = 'd'.repeat(64); }, 'review_context_mismatch'],
  ['missing reviewed hash', v => { v.report.reviewedContextSha256 = null; }, 'invalid_report'],
  ['duplicate coverage', v => { v.report.filesReviewed = ['src/app.mjs', 'src/app.mjs']; }, 'invalid_report'],
  ['invalid findings type', v => { v.report.findings = {}; }, 'invalid_report'],
  ['too many findings', v => { v.report.findings = Array(129).fill({}); }, 'invalid_report'],
  ['too many evidence items', v => { v.report.evidenceChecked = Array(65).fill({}); }, 'invalid_report'],
  ['nonempty limitations', v => { v.report.limitations = ['PRIVATE_MARKER unread diff']; }, 'unresolved_limitations'],
  ['blank limitation', v => { v.report.limitations = [' ']; }, 'invalid_report'],
  ['string limitations', v => { v.report.limitations = 'none'; }, 'invalid_report'],
  ['no evidence', v => { v.report.evidenceChecked = []; }, 'missing_independent_evidence'],
  ['worker-only evidence', v => { v.report.evidenceChecked[0].origin = 'worker-reported'; }, 'missing_independent_evidence'],
  ['unlabeled evidence', v => { v.report.evidenceChecked = ['CI passed']; }, 'invalid_evidence'],
  ['unknown evidence origin', v => { v.report.evidenceChecked[0].origin = 'trusted'; }, 'invalid_evidence'],
  ['blank evidence', v => { v.report.evidenceChecked[0].description = ' '; }, 'invalid_evidence'],
  ['extra evidence field', v => { v.report.evidenceChecked[0].signature = 'PRIVATE_MARKER'; }, 'invalid_evidence']
]) {
  test(`refuses ${label} before any Git capture`, async () => {
    const initial = envelope(), replacement = mutate(initial);
    const input = replacement === undefined ? initial : replacement;
    let calls = 0;
    await refuses(checkCodeReviewReport(JSON.stringify(input), { capture: async () => { calls++; throw Error('PRIVATE_MARKER'); } }), code);
    assert.equal(calls, 0);
  });
}

for (const files of [[], ['src/app.mjs'], ['src/app.mjs', 'unrelated.txt'], ['src/app.mjs', 'old.txt', 'extra.txt'], ['SRC/app.mjs', 'old.txt']]) {
  test(`rejects incomplete or inexact coverage ${JSON.stringify(files)}`, async () => {
    const input = envelope(); input.report.filesReviewed = files;
    await refuses(check(input), 'incomplete_coverage');
  });
}
for (const file of ['../secret', '/secret', 'C:/secret', 'a\\b', 'a\nfile', './src/app.mjs', 'a//b', 'a/../b', 'a/', 'x'.repeat(501)]) {
  test(`refuses noncanonical path ${JSON.stringify(file).slice(0, 45)}`, async () => {
    const input = envelope(); input.report.filesReviewed = [file]; await refuses(check(input), 'invalid_report');
  });
}
const finding = () => ({ path: 'src/app.mjs', location: 'handler', severity: 'low', blocking: false,
  impact: 'An optional clarification would improve readability.', correction: 'Clarify the comment.' });
test('well-formed nonblocking findings and mixed evidence remain representable', async () => {
  const input = envelope(); input.report.findings = [finding()];
  input.report.findings[0].path = 'surrounding.mjs'; input.report.findings[0].location = null;
  input.report.evidenceChecked.push({ origin: 'worker-reported', description: 'Worker reports test success; not independently authenticated.' });
  assert.equal((await check(input)).findings, 1);
});
for (const [label, patch, code] of [
  ['explicit blocker', { blocking: true }, 'blocking_findings'],
  ['high but nonblocking', { severity: 'high', blocking: false }, 'blocking_findings'],
  ['critical but nonblocking', { severity: 'critical', blocking: false }, 'blocking_findings'],
  ['string boolean', { blocking: 'false' }, 'invalid_finding'],
  ['unknown severity', { severity: 'P0' }, 'invalid_finding'],
  ['blank impact', { impact: ' ' }, 'invalid_finding'],
  ['missing correction', { correction: null }, 'invalid_finding'],
  ['extra finding key', { bypass: true }, 'invalid_finding'],
  ['invalid location', { location: 42 }, 'invalid_finding']
]) {
  test(`rejects finding: ${label}`, async () => {
    const input = envelope(); input.report.findings = [{ ...finding(), ...patch }];
    await refuses(check(input), code);
  });
}
for (const patch of [null, { schemaVersion: 2 }, { contextSha256: 'd'.repeat(64) }, { baseOid: 'd'.repeat(40) },
  { headOid: 'd'.repeat(40) }, { packId: 'other' }, { workerId: 'other' }, { verificationCommandSha256: 'd'.repeat(64) },
  { files: [] }, { files: [{ status: 'M', path: 'a' }, { status: 'D', path: 'a' }] }, { files: [{ status: 'R', path: 'a' }] }]) {
  test(`rejects inconsistent capture result ${JSON.stringify(patch)}`, async () => {
    await refuses(checkCodeReviewReport(JSON.stringify(envelope()), { capture: async a => patch === null ? null : { ...snapshot(a), ...patch } }), 'invalid_snapshot');
  });
}
test('capture failures do not echo subprocess output or arbitrary error codes', async () => {
  const error = Object.assign(Error('PRIVATE_MARKER'), { code: 'PRIVATE_MARKER', stdout: 'PRIVATE_MARKER' });
  await refuses(checkCodeReviewReport(JSON.stringify(envelope()), { capture: async () => { throw error; } }), 'snapshot_refused');
});
for (const raw of [undefined, '', {}, 'x'.repeat(MAX_REVIEW_BYTES + 1), '\ud800']) {
  test(`bounds JSON input without coercion (${typeof raw}/${raw?.length ?? 0})`, () => refuses(checkCodeReviewReport(raw), 'invalid_input'));
}
for (const raw of ['{', 'null garbage', 'PRIVATE_MARKER', '{"assignment":']) {
  test(`rejects malformed JSON ${raw}`, () => refuses(checkCodeReviewReport(raw), 'invalid_json'));
}
test('JSON key order, CRLF formatting, and the inclusive UTF-8 input limit are supported', async () => {
  const input = envelope(), raw = JSON.stringify(input, null, 2).replaceAll('\n', '\r\n');
  assert.equal((await checkCodeReviewReport(raw.padEnd(MAX_REVIEW_BYTES), { capture })).status, 'validated');
  await refuses(checkCodeReviewReport(raw + '😀'.repeat(MAX_REVIEW_BYTES / 4), { capture }), 'invalid_input');
});

test('stream reader handles split multibyte UTF-8, exact byte cap, and empty EOF', async () => {
  const value = Buffer.from('😀');
  assert.equal(await readReviewInput(Readable.from([value.subarray(0, 2), value.subarray(2)])), '😀');
  assert.equal((await readReviewInput(Readable.from([Buffer.alloc(MAX_REVIEW_BYTES, 32)]))).length, MAX_REVIEW_BYTES);
  assert.equal(await readReviewInput(Readable.from([])), '');
});
test('stream reader refuses overlarge, invalid UTF-8, and nonbyte input', async () => {
  await refuses(readReviewInput(Readable.from([Buffer.alloc(MAX_REVIEW_BYTES + 1)])), 'input_too_large');
  await refuses(readReviewInput(Readable.from([Buffer.from([0xc3, 0x28])])), 'invalid_utf8');
  await refuses(readReviewInput(Readable.from(['text'])), 'invalid_input');
});
test('stream read deadline and input errors fail closed without hanging', async () => {
  const stream = new PassThrough();
  await refuses(readReviewInput(stream, { timeoutMs: 20 }), 'input_timeout');
  const broken = new PassThrough(); const promise = readReviewInput(broken);
  broken.destroy(new Error('PRIVATE_MARKER')); await refuses(promise, 'input_read_failed');
});

const cleanEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, env: cleanEnv(), encoding: 'utf8',
    timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-report-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  git(root, 'init', '--initial-branch=main'); git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'app.txt'), 'before\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base'); const baseOid = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'app.txt'), 'after\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'change');
  const input = envelope(); Object.assign(input.assignment, { repositoryRoot: root, baseOid, headOid: git(root, 'rev-parse', 'HEAD') });
  const original = { ...input.assignment }; delete original.expectedContextSha256;
  const saved = await createCodeReviewSnapshot(original);
  input.assignment.expectedContextSha256 = saved.contextSha256;
  Object.assign(input.report, { baseOid, headOid: saved.headOid, reviewedContextSha256: saved.contextSha256,
    filesReviewed: saved.files.map(file => file.path) });
  return input;
}
test('real Git report check and CLI recapture clean state without writing index or executing verification', async t => {
  const input = await fixture(t), root = input.assignment.repositoryRoot;
  const marker = path.join(root, 'SHOULD_NOT_EXIST');
  input.assignment.verificationCommand = `node -e "require('fs').writeFileSync('SHOULD_NOT_EXIST','bad')"`;
  const original = { ...input.assignment }; delete original.expectedContextSha256;
  input.assignment.expectedContextSha256 = (await createCodeReviewSnapshot(original)).contextSha256;
  input.report.reviewedContextSha256 = input.assignment.expectedContextSha256;
  const index = readFileSync(path.join(root, '.git', 'index'));
  const result = await checkCodeReviewReport(JSON.stringify(input)); assert.equal(result.status, 'validated');
  const cli = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 0, cli.stdout); assert.equal(cli.stderr, '');
  assert.deepEqual(JSON.parse(cli.stdout), result); assert.ok(!existsSync(marker));
  assert.deepEqual(readFileSync(path.join(root, '.git', 'index')), index);
});
for (const mutation of ['unstaged', 'staged', 'untracked', 'new-head', 'changed-assignment']) {
  test(`real Git check rejects ${mutation} after an original review`, async t => {
    const input = await fixture(t), root = input.assignment.repositoryRoot;
    if (mutation === 'changed-assignment') input.assignment.packId = 'pack-2';
    else {
      await writeFile(path.join(root, mutation === 'untracked' ? 'extra.txt' : 'app.txt'), 'changed again\n');
      if (['staged', 'new-head'].includes(mutation)) git(root, 'add', '.');
      if (mutation === 'new-head') git(root, 'commit', '-m', 'moved');
    }
    await refuses(checkCodeReviewReport(JSON.stringify(input)), 'snapshot_refused');
  });
}
test('CLI refuses unsupported arguments, malformed and oversized input without reflecting it', () => {
  for (const [args, input] of [[['--bypass'], 'PRIVATE_MARKER'], [[], 'PRIVATE_MARKER'],
    [[], Buffer.from([0xff])], [[], 'PRIVATE_MARKER'.repeat(30000)]]) {
    const cli = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(cli.status, 1); assert.equal(cli.stderr, '');
    assert.equal(JSON.parse(cli.stdout).status, 'refused'); assert.ok(!cli.stdout.includes('PRIVATE_MARKER'));
  }
});

test('rejects duplicate and escaped-equivalent keys rather than hiding contradictory decisions', async () => {
  const raw = JSON.stringify(envelope());
  for (const altered of [
    raw.replace('"recommendation":"accept"', '"recommendation":"rework","recommendation":"accept"'),
    raw.replace('"recommendation":"accept"', '"recommen\\u0064ation":"rework","recommendation":"accept"'),
    raw.replace('"packId":"pack-1"', '"packId":"other","packId":"pack-1"'),
    raw.replace('"origin":"independently-observed"', '"origin":"worker-reported","origin":"independently-observed"')
  ]) await refuses(checkCodeReviewReport(altered, { capture }), 'duplicate_key');
});
test('key-like prose and escaped quotes are inert data, not duplicate properties', async () => {
  const input = envelope(); input.report.reviewNote = 'Text: "recommendation":"rework"; \\ { } [ ]';
  assert.equal((await check(input)).status, 'validated');
});
test('bounded JSON nesting rejects excessively deep input', async () => {
  await refuses(checkCodeReviewReport('['.repeat(9) + '0' + ']'.repeat(9)), 'input_too_deep');
});
test('original incomplete rework template is a refusal without requiring Git access', async () => {
  const input = envelope(); Object.assign(input.report, { recommendation: 'rework', reviewedContextSha256: null,
    baseOid: null, headOid: null, filesReviewed: [], evidenceChecked: [], limitations: ['No inspection yet.'] });
  await refuses(checkCodeReviewReport(JSON.stringify(input)), 'review_requires_rework');
});

test('shared coordinator/reviewer protocol requires the executable check and preserves authority boundaries', () => {
  const protocol = readFileSync(new URL('../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/references/code-review.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.match(protocol, /must run `scripts\/code-review-report\.mjs`/u);
  assert.match(protocol, /before recording accept and immediately before finalize/u);
  assert.match(protocol, /snapshot-only check does not substitute for report validation/u);
  for (const field of ['expectedContextSha256', 'filesReviewed', 'evidenceChecked', 'reviewNote']) assert.ok(protocol.includes(field));
  assert.match(protocol, /A label\n  is only a claim, not authentication/u);
  assert.match(protocol, /This check adds no lock or hosted mutation/u);
  assert.match(protocol, /source merge does not update installed clients/u);
});
