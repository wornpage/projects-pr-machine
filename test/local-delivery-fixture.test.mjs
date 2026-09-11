import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createFixture, isolatedEnvironment, lines, readJson, writeJson, REPOSITORY, VERIFY }
  from './fixtures/local-delivery-harness.mjs';

const call = (f, executable, args, overrides = {}) => f.runner({ executable, args, cwd: f.root, shell: false, ...overrides });
async function ownLock(f) {
  await fs.mkdir(f.lock);
  await writeJson(path.join(f.lock, 'owner.json'), { pid: process.pid });
}

test('local adapter environment excludes credentials and inherited Git/Node execution settings', () => {
  const env = isolatedEnvironment('/fixture', { PATH: '/tools', SystemRoot: 'C:/Windows',
    GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', SSH_AUTH_SOCK: 'secret', NODE_OPTIONS: '--import unsafe',
    GIT_CONFIG_COUNT: '99', GIT_DIR: '/foreign', GIT_CONFIG_GLOBAL: '/foreign', HTTPS_PROXY: 'secret' });
  assert.equal(env.PATH, '/tools');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'GIT_DIR', 'HTTPS_PROXY']) assert.equal(env[key], undefined);
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'file');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'never');
  assert.equal(env.GIT_CONFIG_VALUE_1, 'always');
});

test('local adapter performs real Git reads but never spawns gh', { timeout: 30_000 }, async t => {
  const f = await createFixture(t);
  const head = await call(f, 'git', ['rev-parse', 'HEAD']);
  assert.equal(head.stdout.trim(), f.base);
  assert.equal((await call(f, 'git', ['ls-remote', '--heads', 'origin', 'refs/heads/main'])).stdout.split(/\s/u)[0], f.base);
  assert.match((await call(f, 'gh', ['--version'])).stdout, /local stand-in/u);
  assert.equal((await call(f, 'git', ['remote', 'get-url', 'origin'])).stdout.trim(), `https://github.com/${REPOSITORY}.git`);
  assert.equal(await f.git(['remote', 'get-url', 'origin']), f.remote, 'the actual transport is a local bare repo');
  assert.equal((await readJson(f.serviceFile)).pulls.length, 0);
});

test('local adapter rejects every unrecognized or unsafe command without a success fallback', { timeout: 30_000 }, async t => {
  const f = await createFixture(t);
  const outside = path.dirname(f.directory);
  const bad = [
    ['gh', ['pr', 'merge', '1']], ['gh', ['pr', 'ready', '1']], ['gh', ['api', '-X', 'POST', 'repos/other/repo']],
    ['git', ['push', '--delete', 'origin', 'main']], ['git', ['push', 'https://github.com/other/repo', 'main']],
    ['git', ['fetch', 'origin']], ['git', ['-c', 'protocol.allow=always', 'fetch', 'origin']],
    ['git', ['worktree', 'remove', outside]], ['git', ['worktree', 'remove', `${f.directory}/.projects-pr-worktrees/../checkout`]],
    ['git', ['branch', '-D', 'main']], ['git', ['status', '--porcelain']], ['git', ['remote', 'get-url', 'other']],
    ['node', ['-e', 'process.exit(0)']], ['unknown', []], ['/bin/sh', ['-c', 'touch unwanted']],
    [VERIFY, [], { shell: true }], ['git', ['rev-parse', 'HEAD'], { cwd: outside }]
  ];
  for (const [executable, args, overrides] of bad) {
    assert.equal((await call(f, executable, args, overrides)).exitCode, 1, executable);
  }
  assert.equal((await lines(f.auditFile)).filter(x => x.event === 'blocked').length, bad.length);
  assert.equal(await f.git(['rev-parse', 'HEAD']), f.base);
  assert.equal(await f.git(['status', '--porcelain']), '');
});

test('local adapter refuses drifted origins and local push-url overrides', { timeout: 30_000 }, async t => {
  const f = await createFixture(t);
  await f.git(['remote', 'set-url', 'origin', 'https://example.invalid/not-a-repository']);
  assert.equal((await call(f, 'git', ['ls-remote', '--heads', 'origin', 'refs/heads/main'])).exitCode, 1);
  await f.git(['remote', 'set-url', 'origin', f.remote]);
  await f.git(['config', 'remote.origin.pushurl', f.remote]);
  assert.equal((await call(f, 'git', ['remote', 'get-url', 'origin'])).exitCode, 1);
  // Independent defense: Git itself refuses a forbidden protocol before networking.
  const forbidden = await f.run({ executable: 'git', args: ['ls-remote', 'https://example.invalid/repo'], cwd: f.root });
  assert.notEqual(forbidden.exitCode, 0);
  assert.match(forbidden.stderr, /transport 'https' not allowed/u);
});

test('local adapter records real push and simulated draft effects before losing responses', { timeout: 30_000 }, async t => {
  const f = await createFixture(t);
  const branch = 'projects-pr/rehearsal-local-lifecycle';
  const worktree = path.join(f.directory, '.projects-pr-worktrees', 'checkout-rehearsal');
  await ownLock(f);
  await fs.mkdir(path.dirname(worktree));
  assert.equal((await call(f, 'git', ['worktree', 'add', '-b', branch, worktree, f.base])).exitCode, 0);
  await fs.writeFile(path.join(worktree, 'proof.txt'), 'worker\n');
  await f.git(['add', 'proof.txt'], worktree);
  await f.git(['commit', '-m', 'fixture worker'], worktree);
  const head = await f.git(['rev-parse', 'HEAD'], worktree);
  await writeJson(f.serviceFile, { fault: 'push-response-lost', pulls: [] });
  assert.equal((await call(f, 'git', ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktree })).exitCode, 1);
  assert.equal(await f.git(['rev-parse', `refs/heads/${branch}`], f.remote), head);
  await writeJson(f.serviceFile, { fault: 'pr-response-lost', pulls: [] });
  const create = ['pr', 'create', '--repo', `github.com/${REPOSITORY}`, '--draft', '--base', 'main',
    '--head', branch, '--title', 'Fixture', '--body', 'Local-only fixture'];
  assert.equal((await call(f, 'gh', create, { cwd: worktree })).exitCode, 1);
  assert.equal((await readJson(f.serviceFile)).pulls.length, 1);
  assert.equal((await readJson(f.serviceFile)).pulls[0].head.sha, head);
  assert.equal((await readJson(f.serviceFile)).fault, null);
  for (const effect of ['push-effect', 'create-effect']) {
    const events = (await lines(f.auditFile)).filter(x => x.event === effect);
    assert.equal(events.length, 1); assert.match(events[0].ownerSha256, /^[a-f0-9]{64}$/u);
  }
});
