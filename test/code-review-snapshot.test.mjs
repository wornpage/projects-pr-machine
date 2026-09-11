import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCodeReviewSnapshot, defaultReviewGitRunner, parseReviewSnapshotArgs }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/code-review-snapshot.mjs';

const helper = fileURLToPath(new URL('../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/code-review-snapshot.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const cleanEnv = () => ({ ...Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^GIT_/iu.test(key))), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', env: cleanEnv(),
    timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'app.txt'), 'before\n');
  git(root, 'add', '--', 'app.txt'); git(root, 'commit', '-m', 'base');
  const baseOid = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'app.txt'), 'after\n');
  git(root, 'add', '--', 'app.txt'); git(root, 'commit', '-m', 'change');
  return { repositoryRoot: root, baseOid, headOid: git(root, 'rev-parse', 'HEAD'),
    packId: 'pack-1', workerId: 'worker-1', verificationCommand: 'npm run check' };
}
const rejects = (input, code, deps) => assert.rejects(createCodeReviewSnapshot(input, deps), e => e.code === code);
const argsFor = input => ['--repo', input.repositoryRoot, '--base', input.baseOid, '--head', input.headOid,
  '--pack-id', input.packId, '--worker-id', input.workerId, '--verify-command', input.verificationCommand];

test('captures actual committed diff and fresh snapshots have a stable context hash', async t => {
  const input = await fixture(t);
  const index = readFileSync(path.join(input.repositoryRoot, '.git', 'index'));
  const result = await createCodeReviewSnapshot(input);
  assert.equal(result.kind, 'code-review-snapshot');
  assert.deepEqual(result.files, [{ status: 'M', path: 'app.txt' }]);
  assert.equal(result.baseOid, input.baseOid); assert.equal(result.headOid, input.headOid);
  assert.equal(result.verificationCommandSha256, hash(input.verificationCommand));
  const diff = await defaultReviewGitRunner({ args: result.diffArgs, cwd: input.repositoryRoot });
  assert.equal(result.diffSha256, hash(diff.stdout));
  assert.equal(result.diffBytes, diff.stdout.length);
  assert.equal(result.contextSha256, (await createCodeReviewSnapshot(input)).contextSha256);
  assert.deepEqual(readFileSync(path.join(input.repositoryRoot, '.git', 'index')), index);
  assert.ok(!JSON.stringify(result).includes('npm run check'));
  assert.equal(git(input.repositoryRoot, 'status', '--porcelain'), '');
});

test('expected-context mode accepts unchanged code and rejects mismatched context', async t => {
  const input = await fixture(t); const first = await createCodeReviewSnapshot(input);
  assert.equal((await createCodeReviewSnapshot({ ...input, expectedContextSha256: first.contextSha256 })).contextSha256, first.contextSha256);
  await rejects({ ...input, expectedContextSha256: '0'.repeat(64) }, 'review_context_changed');
});

for (const [name, alteration] of [
  ['pack', { packId: 'pack-2' }], ['worker', { workerId: 'worker-2' }],
  ['verification', { verificationCommand: 'npm test' }]
]) {
  test(`changed ${name} cannot reuse a prior review context`, async t => {
    const input = await fixture(t); const first = await createCodeReviewSnapshot(input);
    await rejects({ ...input, ...alteration, expectedContextSha256: first.contextSha256 }, 'review_context_changed');
  });
}

for (const dirty of ['unstaged', 'staged', 'untracked']) {
  test(`refuses ${dirty} changes`, async t => {
    const input = await fixture(t);
    await writeFile(path.join(input.repositoryRoot, dirty === 'untracked' ? 'extra.txt' : 'app.txt'), 'changed again\n');
    if (dirty === 'staged') git(input.repositoryRoot, 'add', '--', 'app.txt');
    await rejects(input, 'dirty_worktree');
  });
}
for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`refuses hidden index entries (${flag})`, async t => {
    const input = await fixture(t);
    git(input.repositoryRoot, 'update-index', flag, '--', 'app.txt');
    await writeFile(path.join(input.repositoryRoot, 'app.txt'), 'hidden change\n');
    await rejects(input, 'hidden_index_entries');
  });
}

test('a new commit invalidates old-head review and the old context at the new head', async t => {
  const input = await fixture(t); const first = await createCodeReviewSnapshot(input);
  await writeFile(path.join(input.repositoryRoot, 'app.txt'), 'third\n');
  git(input.repositoryRoot, 'add', '.'); git(input.repositoryRoot, 'commit', '-m', 'new head');
  await rejects(input, 'head_changed');
  await rejects({ ...input, headOid: git(input.repositoryRoot, 'rev-parse', 'HEAD'), expectedContextSha256: first.contextSha256 }, 'review_context_changed');
});

test('detects a HEAD change during capture with actual Git observations', async t => {
  const input = await fixture(t); let moved = false;
  const runner = async invocation => {
    const result = await defaultReviewGitRunner(invocation);
    if (!moved && invocation.args[0] === 'diff') {
      moved = true; git(input.repositoryRoot, 'commit', '--allow-empty', '-m', 'race');
    }
    return result;
  };
  await rejects(input, 'head_changed', { runner }); assert.ok(moved);
});

test('rejects a base outside the head ancestry', async t => {
  const input = await fixture(t);
  git(input.repositoryRoot, 'checkout', '-b', 'side', input.baseOid);
  await writeFile(path.join(input.repositoryRoot, 'side.txt'), 'side\n');
  git(input.repositoryRoot, 'add', '.'); git(input.repositoryRoot, 'commit', '-m', 'side');
  const other = git(input.repositoryRoot, 'rev-parse', 'HEAD'); git(input.repositoryRoot, 'checkout', 'main');
  await rejects({ ...input, baseOid: other }, 'base_not_ancestor');
});

test('rejects a tree object presented as a commit and a nonexistent full OID', async t => {
  const input = await fixture(t);
  await rejects({ ...input, baseOid: git(input.repositoryRoot, 'rev-parse', 'HEAD^{tree}') }, 'git_read_failed');
  await rejects({ ...input, baseOid: '0'.repeat(40) }, 'git_read_failed');
});

test('rejects empty diffs and repository subdirectories', async t => {
  const input = await fixture(t);
  await rejects({ ...input, baseOid: input.headOid }, 'empty_or_invalid_diff');
  const nested = path.join(input.repositoryRoot, 'nested'); await mkdir(nested);
  await rejects({ ...input, repositoryRoot: nested }, 'repository_mismatch');
});

test('linked worktree identity is stable and bound to its actual Git common directory', async t => {
  const input = await fixture(t);
  const parent = await mkdtemp(path.join(tmpdir(), 'review-worktree-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const linked = path.join(parent, 'linked'); git(input.repositoryRoot, 'worktree', 'add', '--detach', linked, input.headOid);
  const main = await createCodeReviewSnapshot(input);
  const secondary = await createCodeReviewSnapshot({ ...input, repositoryRoot: linked });
  assert.equal(main.gitCommonDir, secondary.gitCommonDir);
  assert.notEqual(main.contextSha256, secondary.contextSha256);
});

test('tracks deletion, addition, and rename as an explicit delete/add inventory', async t => {
  const input = await fixture(t); git(input.repositoryRoot, 'mv', 'app.txt', 'renamed.txt');
  git(input.repositoryRoot, 'commit', '-m', 'rename');
  const result = await createCodeReviewSnapshot({ ...input, headOid: git(input.repositoryRoot, 'rev-parse', 'HEAD') });
  assert.deepEqual(result.files, [{ status: 'D', path: 'app.txt' }, { status: 'A', path: 'renamed.txt' }]);
});

test('refuses overlarge patches rather than hashing truncated output', async t => {
  const input = await fixture(t);
  await writeFile(path.join(input.repositoryRoot, 'app.txt'), 'x'.repeat(1100000));
  git(input.repositoryRoot, 'add', '.'); git(input.repositoryRoot, 'commit', '-m', 'large');
  await rejects({ ...input, headOid: git(input.repositoryRoot, 'rev-parse', 'HEAD') }, 'git_read_incomplete');
});

test('refuses changed file inventories above the v1 limit', async t => {
  const input = await fixture(t);
  for (let i = 0; i < 256; i++) await writeFile(path.join(input.repositoryRoot, `file-${i}`), 'new\n');
  git(input.repositoryRoot, 'add', '.'); git(input.repositoryRoot, 'commit', '-m', 'many files');
  await rejects({ ...input, headOid: git(input.repositoryRoot, 'rev-parse', 'HEAD') }, 'empty_or_oversized_diff');
});

test('verification command text is hashed but never executed', async t => {
  const input = await fixture(t); const marker = path.join(input.repositoryRoot, 'SHOULD_NOT_EXIST');
  input.verificationCommand = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')"`;
  const result = await createCodeReviewSnapshot(input);
  assert.ok(!existsSync(marker)); assert.equal(result.verificationCommandSha256, hash(input.verificationCommand));
  assert.ok(!JSON.stringify(result).includes('writeFileSync'));
});

test('external diff, text conversion, fsmonitor, tracing, and inherited repo redirection are disabled', async t => {
  const input = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'review-helper-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const marker = path.join(outside, 'executed'); const helperPath = path.join(outside, 'untrusted.mjs');
  await writeFile(helperPath, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  const command = `node "${helperPath.replaceAll('\\', '/')}"`;
  git(input.repositoryRoot, 'config', 'diff.external', command);
  git(input.repositoryRoot, 'config', 'diff.fixture.textconv', command);
  git(input.repositoryRoot, 'config', 'core.fsmonitor', command);
  writeFileSync(path.join(input.repositoryRoot, '.git', 'info', 'attributes'), 'app.txt diff=fixture\n');
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_TRACE: process.env.GIT_TRACE, GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF };
  try {
    process.env.GIT_DIR = path.join(outside, 'missing'); process.env.GIT_TRACE = path.join(outside, 'trace');
    process.env.GIT_EXTERNAL_DIFF = command;
    const result = await createCodeReviewSnapshot(input); assert.equal(result.headOid, input.headOid);
    assert.ok(!existsSync(marker)); assert.ok(!existsSync(process.env.GIT_TRACE));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('actual binary changes contribute to the diff hash without exposing their bytes', async t => {
  const input = await fixture(t); await writeFile(path.join(input.repositoryRoot, 'binary.dat'), Buffer.from([0, 255, 1, 2]));
  git(input.repositoryRoot, 'add', '.'); git(input.repositoryRoot, 'commit', '-m', 'binary');
  const result = await createCodeReviewSnapshot({ ...input, headOid: git(input.repositoryRoot, 'rev-parse', 'HEAD') });
  assert.ok(result.files.some(f => f.path === 'binary.dat')); assert.ok(result.diffBytes > 0);
  assert.ok(!Object.hasOwn(result, 'diff')); assert.ok(!Object.hasOwn(result, 'verificationCommand'));
});

for (const [label, change] of [
  ['relative repository', { repositoryRoot: '.' }], ['branch instead of base', { baseOid: 'main' }],
  ['abbreviated head', { headOid: 'abc1234' }], ['option as head', { headOid: '--help' }],
  ['mixed object formats', { headOid: 'a'.repeat(64) }], ['bad expected digest', { expectedContextSha256: 'wrong' }],
  ['oversized command', { verificationCommand: 'x'.repeat(501) }]
]) {
  test(`refuses ${label} before any Git reads`, async t => {
    const input = await fixture(t); let calls = 0;
    await assert.rejects(createCodeReviewSnapshot({ ...input, ...change }, { runner: async () => { calls++; throw Error('bad'); } }));
    assert.equal(calls, 0);
  });
}

test('all reads have bounds and a closed read-only command set', async t => {
  const input = await fixture(t); const observed = [];
  const runner = async call => { observed.push(call); return defaultReviewGitRunner(call); };
  await createCodeReviewSnapshot(input, { runner });
  for (const call of observed) {
    assert.ok(['rev-parse', 'merge-base', 'status', 'ls-files', 'diff', 'config'].includes(call.args[0]));
    assert.equal(call.timeoutMs, 10000); assert.equal(call.maxBuffer, 1048576);
  }
});
for (const result of [{ exitCode: 0, stdout: 'not a Buffer' }, { exitCode: 3, stdout: Buffer.from('private') }]) {
  test('malformed/failed runner observations cannot pass or expose their output', async t => {
    const input = await fixture(t);
    await assert.rejects(createCodeReviewSnapshot(input, { runner: async () => result }), error =>
      error.code === 'git_read_failed' && !error.message.includes('private'));
  });
}

test('an interrupted/oversized runner read cannot yield a snapshot', async t => {
  const input = await fixture(t);
  await rejects(input, 'git_read_incomplete', { runner: async () => { throw new Error('sensitive output'); } });
  await rejects(input, 'git_read_incomplete', { runner: async () => ({ exitCode: 0, stdout: Buffer.alloc(1048577) }) });
});

test('CLI returns bounded refusal without reflecting command text', () => {
  const result = spawnSync(process.execPath, [helper, '--bad', 'SECRET_TEST_VALUE'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'code-review-snapshot', status: 'refused', error: 'invalid_arguments' });
  assert.ok(!result.stdout.includes('SECRET_TEST_VALUE'));
});

test('CLI succeeds for actual Git and refuses a stale expected context', async t => {
  const input = await fixture(t);
  const result = spawnSync(process.execPath, [helper, ...argsFor(input)], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout); assert.equal(JSON.parse(result.stdout).headOid, input.headOid);
  const stale = spawnSync(process.execPath, [helper, ...argsFor(input), '--expect-context', '0'.repeat(64)], { encoding: 'utf8', timeout: 15000 });
  assert.equal(stale.status, 1); assert.equal(JSON.parse(stale.stdout).error, 'review_context_changed');
});

test('argument parser rejects missing, duplicate, unknown, and odd arguments', () => {
  for (const args of [[], ['--repo'], ['--repo', '/tmp'], ['--bad', 'x']]) assert.throws(() => parseReviewSnapshotArgs(args));
  const good = argsFor({ repositoryRoot: '/tmp/repo', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40), packId: 'p', workerId: 'w', verificationCommand: 'npm test' });
  assert.equal(parseReviewSnapshotArgs(good).packId, 'p');
  assert.throws(() => parseReviewSnapshotArgs([...good, '--repo', '/other']));
});

test('configured clean filters are refused before a status read can execute them', async t => {
  const input = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'review-filter-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const marker = path.join(outside, 'executed'); const filter = path.join(outside, 'filter.mjs');
  await writeFile(filter, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); process.stdin.pipe(process.stdout);`);
  git(input.repositoryRoot, 'config', 'filter.fixture.clean', `node "${filter.replaceAll('\\', '/')}"`);
  writeFileSync(path.join(input.repositoryRoot, '.git', 'info', 'attributes'), 'app.txt filter=fixture\n');
  // Same-size edits force content comparison rather than a size-only shortcut.
  await writeFile(path.join(input.repositoryRoot, 'app.txt'), 'other\n');
  let code;
  try { await createCodeReviewSnapshot(input); } catch (error) { code = error.code; }
  assert.ok(!existsSync(marker), 'content filter must never execute');
  assert.equal(code, 'content_filters_unsupported');
});

test('gitlinks are refused before recursively inspecting submodule working trees', async t => {
  const input = await fixture(t);
  git(input.repositoryRoot, 'update-index', '--add', '--cacheinfo', `160000,${input.headOid},submodule`);
  git(input.repositoryRoot, 'commit', '-m', 'gitlink');
  await rejects({ ...input, headOid: git(input.repositoryRoot, 'rev-parse', 'HEAD') }, 'submodules_unsupported');
});
