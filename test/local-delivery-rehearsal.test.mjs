import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createFixture, cli, lines, readJson, writeJson, VERIFY } from './fixtures/local-delivery-harness.mjs';
import { createCodeReviewSnapshot }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/code-review-snapshot.mjs';
import { checkCodeReviewReport }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/code-review-report.mjs';

const LIMIT = { timeout: 90_000 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ownerFile = f => path.join(f.lock, 'owner.json');
const events = async (f, name) => (await lines(f.auditFile)).filter(item => item.event === name);
const absent = file => assert.rejects(fs.stat(file), { code: 'ENOENT' });
async function succeed(f, command, status, extra = []) {
  const result = await cli(f, command, extra);
  assert.equal(result.exitCode, 0, result.text);
  assert.equal(result.receipt.status, status, result.text);
  return result.receipt;
}
async function refuses(f, command, code) {
  const result = await cli(f, command);
  assert.equal(result.exitCode, 1, result.text);
  assert.equal(result.receipt.status, 'failed');
  assert.equal(result.receipt.error.code, code, result.text);
  assert.ok(!result.text.includes('PRIVATE_FIXTURE_VERIFICATION_OUTPUT'));
  return result.receipt;
}
async function prepared(t) {
  const f = await createFixture(t);
  const receipt = await succeed(f, 'prepare', 'prepared');
  f.plan = receipt.plan;
  assert.equal(await f.git(['rev-parse', 'HEAD'], f.plan.worktreePath), f.base);
  assert.equal((await readJson(f.stateFile)).phase, 'prepared');
  await absent(f.lock);
  return f;
}
async function worker(f, contents = 'worker\n') {
  await fs.writeFile(path.join(f.plan.worktreePath, 'proof.txt'), contents);
  await f.git(['add', 'proof.txt'], f.plan.worktreePath);
  await f.git(['commit', '-m', 'worker change'], f.plan.worktreePath);
  return f.git(['rev-parse', 'HEAD'], f.plan.worktreePath);
}
async function review(f, head) {
  const assignment = { repositoryRoot: f.plan.worktreePath, baseOid: f.base, headOid: head,
    packId: 'rehearsal', workerId: 'fixture-worker', verificationCommand: VERIFY };
  // An independent Git read supplies the expected inventory, not worker prose.
  const files = (await f.git(['diff', '--name-only', '--no-renames', `${f.base}..${head}`], f.plan.worktreePath)).split('\n');
  assert.ok(files.includes('proof.txt'));
  const snapshot = await createCodeReviewSnapshot(assignment);
  assert.deepEqual(snapshot.files.map(file => file.path).sort(), [...files].sort());
  const envelope = { assignment: { ...assignment, expectedContextSha256: snapshot.contextSha256 },
    report: { recommendation: 'accept', reviewedContextSha256: snapshot.contextSha256,
      baseOid: f.base, headOid: head, filesReviewed: files, findings: [], limitations: [],
      evidenceChecked: [{ origin: 'independently-observed', description: 'Synthetic test: compared real Git diff inventory. Not an agent or human approval.' }],
      reviewNote: 'Consistency-test report only; no production acceptance or approval.' } };
  const checked = await checkCodeReviewReport(JSON.stringify(envelope));
  assert.equal(checked.status, 'validated');
  assert.equal(checked.headOid, head);
  return envelope;
}
async function completed(f, head) {
  const result = await succeed(f, 'finalize', 'completed');
  assert.equal(result.result.draftPullRequest.headOid, head);
  assert.equal(result.result.draftPullRequest.draft, true);
  assert.equal(result.result.ownerDecision.merge.status, 'not_requested');
  const state = await readJson(f.stateFile);
  assert.equal(state.phase, 'completed');
  assert.equal(state.verifiedCommit, head);
  assert.equal(state.pushedCommit, head);
  assert.equal(await f.git(['rev-parse', `refs/heads/${f.plan.branch}`], f.remote), head);
  assert.equal(await f.git(['rev-parse', `refs/heads/${f.plan.branch}`]), head);
  assert.equal(await f.git(['rev-parse', 'refs/heads/main']), f.base);
  await absent(f.plan.worktreePath); await absent(f.lock);
  assert.equal((await events(f, 'push-effect')).length, 1);
  assert.equal((await events(f, 'create-effect')).length, 1);
  assert.equal((await readJson(f.serviceFile)).pulls.length, 1);
  assert.equal((await events(f, 'blocked')).length, 0, 'the test adapter must support the actual production calls');
  return result;
}

test('local lifecycle: separate CLI processes prepare, review, verify, finalize, and replay one exact draft', LIMIT, async t => {
  const f = await createFixture(t);
  const before = await f.git(['show-ref']);
  await succeed(f, 'doctor', 'ready');
  assert.equal(await f.git(['show-ref']), before);
  await absent(f.lock); await absent(f.stateFile);
  f.plan = (await succeed(f, 'prepare', 'prepared')).plan;
  const head = await worker(f);
  await review(f, head);
  assert.equal((await lines(f.verificationFile)).length, 0, 'snapshot and report guard do not execute verification');
  const status = await succeed(f, 'status', 'observed');
  assert.equal(status.result.observed.worktree.headOid, head);
  await completed(f, head);
  const verifications = await lines(f.verificationFile);
  assert.equal(verifications.length, 1); assert.equal(verifications[0].head, head);
  const saved = await fs.readFile(f.stateFile);
  const replay = await succeed(f, 'finalize', 'completed');
  assert.equal(replay.result.resumed, true);
  assert.deepEqual(await fs.readFile(f.stateFile), saved);
  assert.equal((await lines(f.verificationFile)).length, 1);
  assert.equal((await events(f, 'push-effect')).length, 1);
  assert.equal((await events(f, 'create-effect')).length, 1);
  const starts = await events(f, 'cli-start');
  assert.equal(starts.length, 5);
  assert.ok(starts.every(x => x.pid !== process.pid), 'CLI dispatch must run outside the test process');
});

for (const fault of ['push-response-lost', 'pr-response-lost']) {
  test(`local lifecycle: ${fault} resumes from observed effects without duplicate push or draft`, LIMIT, async t => {
    const f = await prepared(t);
    const head = await worker(f);
    await writeJson(f.serviceFile, { fault, pulls: [] });
    await refuses(f, 'finalize', 'command_failed');
    assert.equal(await f.git(['rev-parse', `refs/heads/${f.plan.branch}`], f.remote), head);
    assert.equal((await readJson(f.stateFile)).phase, fault === 'push-response-lost' ? 'prepared' : 'pushed');
    await fs.stat(f.plan.worktreePath); await absent(f.lock);
    const observed = await succeed(f, 'status', 'observed');
    assert.equal(observed.result.observed.remoteBranch.oid, head);
    if (fault === 'pr-response-lost') assert.equal(observed.result.observed.pullRequestCount, 1);
    const result = await completed(f, head);
    assert.equal(result.result.resumed, true);
    assert.deepEqual((await lines(f.verificationFile)).map(x => x.head), [head, head]);
  });
}

test('local lifecycle: an uncertain real push retains evidence and blocks a fresh CLI retry', LIMIT, async t => {
  const f = await prepared(t);
  const head = await worker(f);
  await writeJson(f.serviceFile, { fault: 'push-uncertain', pulls: [] });
  const failed = await refuses(f, 'finalize', 'lifecycle_process_uncertain');
  assert.equal(failed.operationOutcome, 'unknown');
  const bytes = await fs.readFile(ownerFile(f));
  const [pushed] = await events(f, 'push-effect');
  assert.equal(digest(bytes), pushed.ownerSha256);
  assert.equal(await f.git(['rev-parse', `refs/heads/${f.plan.branch}`], f.remote), head);
  const audit = await lines(f.auditFile);
  const effectIndex = audit.findIndex(x => x.event === 'push-effect');
  assert.equal(audit.slice(effectIndex + 1).some(x => x.event === 'invoke' && x.pid === pushed.pid), false);
  await refuses(f, 'finalize', 'lifecycle_locked');
  await succeed(f, 'status', 'observed');
  assert.deepEqual(await fs.readFile(ownerFile(f)), bytes);
  assert.equal((await events(f, 'push-effect')).length, 1);
  assert.equal((await events(f, 'create-effect')).length, 0);
  await fs.stat(f.plan.worktreePath);
});

test('local lifecycle: failed real verification preserves work and redacts its output', LIMIT, async t => {
  const f = await prepared(t);
  const head = await worker(f, 'not ready\n');
  const failed = await refuses(f, 'finalize', 'verification_failed');
  assert.equal(failed.error.exitCode, 7);
  assert.equal((await lines(f.verificationFile))[0].head, head);
  await fs.stat(f.plan.worktreePath); await absent(f.lock);
  assert.equal((await events(f, 'push-effect')).length, 0);
  assert.equal((await events(f, 'create-effect')).length, 0);
  assert.equal((await readJson(f.stateFile)).phase, 'prepared');
});

for (const mode of ['dirty', 'new-head']) {
  test(`local lifecycle: real verification creating ${mode} refuses publication`, LIMIT, async t => {
    const f = await prepared(t);
    await worker(f);
    const script = path.join(f.plan.worktreePath, 'verify.mjs');
    await fs.appendFile(script, `\nfs.writeFileSync('verification-side-effect.txt', 'changed');\n` + (mode === 'new-head'
      ? `execFileSync('git', ['add', 'verification-side-effect.txt']);\nexecFileSync('git', ['commit', '-m', 'verification mutation']);\n` : ''));
    await f.git(['add', 'verify.mjs'], f.plan.worktreePath);
    await f.git(['commit', '-m', 'fixture verification mutation'], f.plan.worktreePath);
    const head = await f.git(['rev-parse', 'HEAD'], f.plan.worktreePath);
    await refuses(f, 'finalize', 'verification_mutated_worktree');
    if (mode === 'new-head') assert.notEqual(await f.git(['rev-parse', 'HEAD'], f.plan.worktreePath), head);
    else assert.ok((await f.git(['status', '--porcelain'], f.plan.worktreePath)).includes('verification-side-effect.txt'));
    assert.equal((await events(f, 'push-effect')).length, 0);
    assert.equal((await events(f, 'create-effect')).length, 0);
    await fs.stat(f.plan.worktreePath); await absent(f.lock);
  });
}

test('local lifecycle: an unchanged preparation can abort but worker commits cannot', LIMIT, async t => {
  const f = await prepared(t);
  await refuses(f, 'finalize', 'no_change_commit');
  assert.equal((await lines(f.verificationFile)).length, 0);
  await succeed(f, 'abort', 'aborted');
  await absent(f.plan.worktreePath); await absent(f.lock);
  assert.equal(await f.git(['for-each-ref', '--format=%(objectname)', `refs/heads/${f.plan.branch}`]), '');
  await succeed(f, 'abort', 'aborted');
  const g = await prepared(t);
  const head = await worker(g);
  await refuses(g, 'abort', 'abort_refused');
  assert.equal(await g.git(['rev-parse', 'HEAD'], g.plan.worktreePath), head);
  await absent(g.lock);
});

test('local lifecycle: a conflicting remote ref is not overwritten or given a draft', LIMIT, async t => {
  const f = await prepared(t);
  const head = await worker(f);
  await f.git(['push', 'origin', `${f.base}:refs/heads/${f.plan.branch}`]);
  await refuses(f, 'finalize', 'remote_branch_mismatch');
  assert.equal(await f.git(['rev-parse', `refs/heads/${f.plan.branch}`], f.remote), f.base);
  assert.equal(await f.git(['rev-parse', 'HEAD'], f.plan.worktreePath), head);
  assert.equal((await events(f, 'push-effect')).length, 0);
  assert.equal((await events(f, 'create-effect')).length, 0);
  await absent(f.lock);
});

test('local lifecycle: local/remote base mismatch refuses before verification or publication', LIMIT, async t => {
  const f = await prepared(t);
  await worker(f);
  await fs.writeFile(path.join(f.root, 'base-change.txt'), 'new local base\n');
  await f.git(['add', 'base-change.txt']); await f.git(['commit', '-m', 'advance local base']);
  const failed = await refuses(f, 'finalize', 'capability_unavailable');
  assert.equal(failed.capability.checks.find(x => x.id === 'remote_base_oid').code, 'remote_base_mismatch');
  assert.equal((await lines(f.verificationFile)).length, 0);
  assert.equal((await events(f, 'push-effect')).length, 0);
  await fs.stat(f.plan.worktreePath); await absent(f.lock);
});

test('local lifecycle: a changed worker head invalidates the old report before a fresh review and draft', LIMIT, async t => {
  const f = await prepared(t);
  const head = await worker(f);
  const envelope = await review(f, head);
  await fs.writeFile(path.join(f.plan.worktreePath, 'extra.txt'), 'second commit\n');
  await f.git(['add', 'extra.txt'], f.plan.worktreePath);
  await f.git(['commit', '-m', 'worker revision'], f.plan.worktreePath);
  await assert.rejects(checkCodeReviewReport(JSON.stringify(envelope)), { code: 'snapshot_refused' });
  assert.equal((await events(f, 'push-effect')).length, 0);
  const revised = await f.git(['rev-parse', 'HEAD'], f.plan.worktreePath);
  await review(f, revised);
  await completed(f, revised);
});
