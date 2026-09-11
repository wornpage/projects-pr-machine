import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireRepositoryLifecycleLock, withRepositoryLifecycleLock, LIFECYCLE_LOCK_NAME
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/repository-lock.mjs';

const moduleUrl = new URL('../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/repository-lock.mjs', import.meta.url).href;
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/iu.test(k))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd, env: env(), encoding: 'utf8',
    timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
const runner = async ({ args, cwd, executable, shell, timeoutMs }) => {
  assert.equal(executable, 'git'); assert.equal(shell, false); assert.equal(timeoutMs, 10000);
  assert.ok(['rev-parse --show-toplevel', 'rev-parse --git-common-dir'].includes(args.join(' ')));
  return { exitCode: 0, stdout: `${git(cwd, ...args)}\n` };
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'projects-pr-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '--initial-branch=main');
  return { root, lockPath: path.join(root, '.git', LIFECYCLE_LOCK_NAME),
    ownerPath: path.join(root, '.git', LIFECYCLE_LOCK_NAME, 'owner.json') };
}
const missing = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
const refuses = (promise, code) => assert.rejects(promise, e => e.code === code);

test('exclusive acquisition records bounded ownership and repeated release is safe', async t => {
  const f = await fixture(t); const release = await acquireRepositoryLifecycleLock(f.root, { runner });
  const owner = JSON.parse(await fs.readFile(f.ownerPath, 'utf8'));
  assert.deepEqual(Object.keys(owner), ['schemaVersion', 'kind', 'token', 'pid', 'startedAt']);
  assert.equal(owner.schemaVersion, 1); assert.equal(owner.pid, process.pid);
  assert.match(owner.token, /^[0-9a-f-]{36}$/u); assert.ok(Date.parse(owner.startedAt));
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.lockPath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(f.ownerPath)).mode & 0o777, 0o600);
  }
  await Promise.all([release(), release()]); await release(); await missing(f.lockPath);
  const next = await acquireRepositoryLifecycleLock(f.root, { runner }); await next();
});

test('existing owner is not changed and contending operation never starts', async t => {
  const f = await fixture(t); const release = await acquireRepositoryLifecycleLock(f.root, { runner });
  const bytes = await fs.readFile(f.ownerPath); let calls = 0;
  await refuses(withRepositoryLifecycleLock(f.root, () => { calls++; }, { runner }), 'lifecycle_locked');
  assert.equal(calls, 0); assert.deepEqual(await fs.readFile(f.ownerPath), bytes); await release();
});

test('operation result and original exception are preserved; both release the lock', async t => {
  const f = await fixture(t); const result = { status: 'completed' };
  assert.equal(await withRepositoryLifecycleLock(f.root, async () => {
    assert.ok((await fs.lstat(f.lockPath)).isDirectory()); return result;
  }, { runner }), result); await missing(f.lockPath);
  const original = Error('operation failure');
  await assert.rejects(withRepositoryLifecycleLock(f.root, () => { throw original; }, { runner }), e => e === original);
  await missing(f.lockPath);
  await assert.rejects(withRepositoryLifecycleLock(f.root, () => Promise.reject(null), { runner }), e => e === null);
  await missing(f.lockPath);
});

test('lock covers the entire awaited operation, not just its synchronous prefix', async t => {
  const f = await fixture(t); let finish; let entered;
  const ready = new Promise(r => { entered = r; });
  const held = withRepositoryLifecycleLock(f.root, async () => {
    const wait = new Promise(r => { finish = r; }); entered(); await wait;
  }, { runner });
  await ready;
  await refuses(acquireRepositoryLifecycleLock(f.root, { runner }), 'lifecycle_locked');
  finish(); await held; await missing(f.lockPath);
});

test('different repositories can hold independent locks', async t => {
  const a = await fixture(t); const b = await fixture(t);
  const releases = await Promise.all([a, b].map(f => acquireRepositoryLifecycleLock(f.root, { runner })));
  assert.ok((await fs.stat(a.ownerPath)).isFile()); assert.ok((await fs.stat(b.ownerPath)).isFile());
  await Promise.all(releases.map(release => release()));
});

test('linked worktrees and the main checkout share the same canonical lock', async t => {
  const f = await fixture(t); git(f.root, 'commit', '--allow-empty', '-m', 'base');
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'projects-pr-linked-lock-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const linked = path.join(parent, 'linked'); git(f.root, 'worktree', 'add', '--detach', linked, 'HEAD');
  const release = await acquireRepositoryLifecycleLock(linked, { runner });
  assert.ok((await fs.stat(f.ownerPath)).isFile());
  await refuses(acquireRepositoryLifecycleLock(f.root, { runner }), 'lifecycle_locked');
  await release(); await missing(f.lockPath);
});

for (const existing of ['directory', 'file', 'junction']) {
  test(`existing ${existing} at the lock path is never removed or followed`, async t => {
    const f = await fixture(t);
    if (existing === 'directory') await fs.mkdir(f.lockPath);
    if (existing === 'file') await fs.writeFile(f.lockPath, 'foreign');
    if (existing === 'junction') {
      const target = path.join(f.root, 'foreign'); await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'sentinel'), 'untouched');
      await fs.symlink(target, f.lockPath, 'junction');
    }
    await refuses(acquireRepositoryLifecycleLock(f.root, { runner }), 'lifecycle_locked');
    assert.ok(await fs.lstat(f.lockPath));
    if (existing === 'junction') assert.equal(await fs.readFile(path.join(f.root, 'foreign', 'sentinel'), 'utf8'), 'untouched');
  });
}

test('unsupported subdirectory and failed/malformed Git discovery cause no lock writes', async t => {
  const f = await fixture(t); const nested = path.join(f.root, 'nested'); await fs.mkdir(nested);
  await refuses(acquireRepositoryLifecycleLock(nested, { runner }), 'lifecycle_lock_unavailable');
  for (const observation of [undefined, { exitCode: 1, stdout: 'PRIVATE' }, { exitCode: 0, stdout: '' },
    { exitCode: 0, stdout: 7 }, { exitCode: 0, stdout: 'a\nb\n' }, { exitCode: 0, stdout: 'x'.repeat(8193) }]) {
    await refuses(acquireRepositoryLifecycleLock(f.root, { runner: async () => observation }), 'lifecycle_lock_unavailable');
  }
  await refuses(acquireRepositoryLifecycleLock(f.root, { runner: async () => { throw Error('PRIVATE'); } }), 'lifecycle_lock_unavailable');
  await missing(f.lockPath);
});

for (const invalid of [undefined, null, '', ' ', 42, {}, '/bad\npath', 'x'.repeat(1001)]) {
  test(`invalid root (${typeof invalid}/${String(invalid).length}) fails before Git`, async () => {
    let calls = 0;
    await refuses(acquireRepositoryLifecycleLock(invalid, { runner: async () => { calls++; } }), 'lifecycle_lock_unavailable');
    assert.equal(calls, 0);
  });
}

test('initialization failure retains partial lock and prevents operation execution', async t => {
  const f = await fixture(t); let entered = false;
  await refuses(withRepositoryLifecycleLock(f.root, () => { entered = true; }, { runner,
    fs: { ...fs, open: async () => { throw Error('PRIVATE initialization failure'); } } }), 'lifecycle_lock_initialization_failed');
  assert.equal(entered, false); assert.deepEqual(await fs.readdir(f.lockPath), []);
  await refuses(acquireRepositoryLifecycleLock(f.root, { runner }), 'lifecycle_locked');
});

test('mkdir permission failure does not start the operation or leak underlying diagnostics', async t => {
  const f = await fixture(t); let entered = false;
  await assert.rejects(withRepositoryLifecycleLock(f.root, () => { entered = true; }, { runner,
    fs: { ...fs, mkdir: async () => { throw Object.assign(Error('PRIVATE'), { code: 'EACCES' }); } } }),
  e => e.code === 'lifecycle_lock_unavailable' && !e.message.includes('PRIVATE'));
  assert.equal(entered, false); await missing(f.lockPath);
});

for (const mutation of ['owner-content', 'owner-replaced', 'directory-replaced', 'extra-file', 'hardlink']) {
  test(`release preserves uncertain ownership (${mutation})`, async t => {
    const f = await fixture(t); const release = await acquireRepositoryLifecycleLock(f.root, { runner });
    const bytes = await fs.readFile(f.ownerPath);
    if (mutation === 'owner-content') await fs.writeFile(f.ownerPath, Buffer.alloc(bytes.length, 32));
    if (mutation === 'owner-replaced') {
      const other = path.join(f.root, 'other-owner'); await fs.writeFile(other, bytes); await fs.rename(other, f.ownerPath);
    }
    if (mutation === 'directory-replaced') {
      await fs.rename(f.lockPath, `${f.lockPath}.original`); await fs.mkdir(f.lockPath); await fs.writeFile(f.ownerPath, bytes);
    }
    if (mutation === 'extra-file') await fs.writeFile(path.join(f.lockPath, 'foreign'), 'keep');
    if (mutation === 'hardlink') await fs.link(f.ownerPath, path.join(f.root, 'linked-owner'));
    await refuses(release(), 'lifecycle_lock_release_failed');
    await refuses(release(), 'lifecycle_lock_release_failed');
    assert.ok(await fs.lstat(f.lockPath)); assert.ok(await fs.lstat(f.ownerPath));
  });
}

for (const failed of [false, true]) {
  test(`cleanup failure reports whether the operation ${failed ? 'failed' : 'returned'}, without retry`, async t => {
    const f = await fixture(t); let calls = 0;
    await assert.rejects(withRepositoryLifecycleLock(f.root, async () => {
      calls++; if (failed) throw Error('PRIVATE'); return { effect: 'may have occurred' };
    }, { runner, fs: { ...fs, rmdir: async () => { throw Error('PRIVATE'); } } }),
    e => e.code === 'lifecycle_lock_release_failed' && e.operationOutcome === (failed ? 'failed' : 'returned') && !e.message.includes('PRIVATE'));
    assert.equal(calls, 1); assert.ok(await fs.lstat(f.lockPath));
    await refuses(acquireRepositoryLifecycleLock(f.root, { runner }), 'lifecycle_locked');
  });
}

function message(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error('child message deadline')); }, 15000);
    const onMessage = value => { cleanup(); resolve(value); };
    const onExit = () => { cleanup(); reject(Error('child exited before observation')); };
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
    child.once('message', onMessage); child.once('exit', onExit);
  });
}
function childHolder(t, root) {
  const source = `import { execFileSync } from 'node:child_process';
    import { withRepositoryLifecycleLock } from ${JSON.stringify(moduleUrl)};
    const runner = async ({executable,args,cwd,timeoutMs}) => ({exitCode:0,
      stdout:execFileSync(executable,args,{cwd,encoding:'utf8',timeout:timeoutMs})});
    try {
      await withRepositoryLifecycleLock(${JSON.stringify(root)}, async () => {
        const done = new Promise(resolve => process.once('message', resolve));
        process.send({state:'held'}); await done;
      }, {runner}); process.send({state:'released'});
    } catch (e) { process.send({state:'refused',code:e.code}); }
    process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: env(), stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  });
  return child;
}

test('actual separate Node processes cannot overlap; graceful completion permits reacquisition', async t => {
  const f = await fixture(t); const holder = childHolder(t, f.root);
  assert.deepEqual(await message(holder), { state: 'held' });
  const contender = childHolder(t, f.root);
  assert.deepEqual(await message(contender), { state: 'refused', code: 'lifecycle_locked' });
  const released = message(holder); holder.send('release');
  assert.deepEqual(await released, { state: 'released' });
  const release = await acquireRepositoryLifecycleLock(f.root, { runner }); await release();
});

test('killed holder leaves evidence and a later process refuses instead of stealing the lock', async t => {
  const f = await fixture(t); const holder = childHolder(t, f.root);
  assert.deepEqual(await message(holder), { state: 'held' });
  const bytes = await fs.readFile(f.ownerPath); const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited;
  const contender = childHolder(t, f.root);
  assert.deepEqual(await message(contender), { state: 'refused', code: 'lifecycle_locked' });
  assert.deepEqual(await fs.readFile(f.ownerPath), bytes);
});
