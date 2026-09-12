import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as surface from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs';
import { createFixture, readJson, lines, VERIFY } from './fixtures/local-delivery-harness.mjs';

const methods = { prepare: 'prepareProjectsPr', finalize: 'finalizeProjectsPr', abort: 'abortProjectsPr',
  stack: 'stackProjectsPr', authorize: 'authorizeProjectsPr', 'authorize-admin': 'authorizeAdminProjectsPr', finish: 'finishProjectsPr' };
const inputFor = root => ({ repositoryRoot: root, packId: 'original', packIds: ['original', 'next'],
  title: 'Original', baseBranch: 'main', remote: 'origin', verificationCommand: VERIFY,
  reviewedHead: 'a'.repeat(40), confirmReview: true, confirmOwner: false,
  reason: 'Original', bypassedRequirements: ['github-ruleset:update'] });

async function localPaths(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'mutation-input-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(directory, 'original'); const other = path.join(directory, 'other');
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(path.join(other, '.git'), { recursive: true });
  return { directory, root, other, lock: path.join(root, '.git', 'projects-pr-v2.lock') };
}
const success = stdout => ({ exitCode: 0, stdout, stderr: '' });

for (const [command, method] of Object.entries(methods)) {
  test(`invocation capture: ${command} cannot redirect the locked repository before core entry`, async t => {
    const f = await localPaths(t); const input = inputFor(f.root);
    let calls = 0; let entered = false; let observed; let ownerPresent = false;
    const runner = async call => {
      calls++;
      if (calls === 1) {
        input.repositoryRoot = f.other; input.packId = 'substituted';
        input.packIds.reverse();
        input.title = 'Changed'; input.verificationCommand = 'CHANGED';
        return success(`${f.root}\n`);
      }
      if (calls === 2) return success('.git\n');
      entered = true; observed = call.cwd;
      ownerPresent = (await fs.stat(path.join(f.lock, 'owner.json'))).isFile();
      throw new Error('Stop before any core effect');
    };
    await assert.rejects(surface[method](input, { runner, nodeVersion: '22.0.0' }));
    assert.ok(entered, 'original valid inputs must reach core under the acquired lock');
    assert.equal(observed, f.root); assert.ok(ownerPresent);
    await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(f.other, '.git')), []);
  });

  test(`invocation capture: ${command} contention receipt keeps the original pack and root`, async t => {
    const f = await localPaths(t); const input = inputFor(f.root);
    await fs.mkdir(f.lock); await fs.writeFile(path.join(f.lock, 'sentinel'), 'untouched');
    let calls = 0;
    await assert.rejects(surface[method](input, { runner: async () => {
      calls++;
      if (calls === 1) {
        input.repositoryRoot = f.other; input.packId = 'substituted'; input.packIds[0] = 'substituted';
        return success(`${f.root}\n`);
      }
      return success('.git\n');
    } }), error => {
      assert.equal(error.code, 'lifecycle_locked'); assert.equal(error.receipt.operationOutcome, 'not_started');
      assert.equal(error.receipt.command, command);
      assert.deepEqual(error.receipt.recovery.args, ['--repo', f.root, '--pack-id', 'original']);
      return true;
    });
    assert.equal(calls, 2); assert.equal(await fs.readFile(path.join(f.lock, 'sentinel'), 'utf8'), 'untouched');
    assert.deepEqual(await fs.readdir(f.lock), ['sentinel']);
  });

  test(`invocation capture: ${command} refuses mutable/accessor input before I/O`, async () => {
    let reads = 0;
    const input = inputFor(path.resolve('never-created'));
    Object.defineProperty(input, 'repositoryRoot', { get() { reads++; return 'PRIVATE'; } });
    await assert.rejects(surface[method](input, { runner: async () => { reads++; },
      fs: new Proxy({}, { get() { reads++; throw new Error('must not read'); } }) }), error => {
      assert.ok(error instanceof surface.ProjectsPrError); assert.equal(error.code, 'invalid_input');
      assert.ok(!String(error).includes('PRIVATE')); return true;
    });
    assert.equal(reads, 0);
  });
}

test('invocation capture: replacing the dependency filesystem cannot switch core after lock discovery', async t => {
  const f = await localPaths(t); const input = inputFor(f.root);
  let calls = 0; let substitutedReads = 0; const stateReads = [];
  const originalFs = { ...fs, readFile: async (name, ...args) => {
    if (String(name).includes('projects-pr-v2' + path.sep)) stateReads.push(name);
    return fs.readFile(name, ...args);
  } };
  const dependencies = { fs: originalFs, runner: async call => {
    calls++;
    if (calls === 1) dependencies.fs = new Proxy({}, { get() { substitutedReads++; throw new Error('substituted'); } });
    return success(call.args.includes('--show-toplevel') ? `${f.root}\n` : '.git\n');
  } };
  await assert.rejects(surface.finalizeProjectsPr(input, dependencies), { code: 'state_not_found' });
  assert.equal(substitutedReads, 0);
  assert.deepEqual(stateReads, [path.join(f.root, '.git', 'projects-pr-v2', 'original.json')]);
  await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' });
});

for (const mode of ['omitted', 'relative']) {
  test(`invocation capture: ${mode} repository is bound before process cwd changes`, async t => {
    const f = await localPaths(t); const before = process.cwd(); const seen = []; let calls = 0;
    try {
      process.chdir(mode === 'omitted' ? f.root : f.directory);
      const input = { packId: 'original', ...(mode === 'relative' ? { repositoryRoot: 'original' } : {}) };
      await assert.rejects(surface.finalizeProjectsPr(input, { runner: async call => {
        calls++; seen.push(call.cwd);
        if (calls === 1) process.chdir(f.other);
        return success(call.args.includes('--show-toplevel') ? `${f.root}\n` : '.git\n');
      } }), { code: 'state_not_found' });
      assert.equal(calls, 4); assert.ok(seen.every(cwd => cwd === f.root));
      await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(path.join(f.other, '.git')), []);
    } finally { process.chdir(before); }
  });
}

async function prepared(t) {
  const f = await createFixture(t);
  const input = { ...inputFor(f.root), packId: 'rehearsal' };
  await surface.prepareProjectsPr(input, { runner: f.runner });
  f.preparedState = await readJson(f.stateFile);
  return f;
}

test('invocation capture: real local abort affects only its originally locked preparation', { timeout: 90000 }, async t => {
  const f = await prepared(t); const other = await prepared(t);
  const otherBytes = await fs.readFile(other.stateFile); const input = { repositoryRoot: f.root, packId: 'rehearsal' };
  let changed = false;
  const receipt = await surface.abortProjectsPr(input, { runner: async call => {
    if (!changed) { changed = true; input.repositoryRoot = other.root; input.packId = 'different'; }
    return f.runner(call);
  } });
  assert.equal(receipt.status, 'aborted'); assert.equal(receipt.packId, 'rehearsal');
  assert.equal(receipt.repository.root, f.root);
  assert.equal((await readJson(f.stateFile)).phase, 'aborted');
  await assert.rejects(fs.stat(f.preparedState.worktreePath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(other.stateFile), otherBytes);
  assert.ok((await fs.stat(other.preparedState.worktreePath)).isDirectory());
  assert.deepEqual(await lines(f.verificationFile), []); assert.deepEqual(await lines(other.verificationFile), []);
  await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(other.lock), { code: 'ENOENT' });
});

for (const [command, method] of [['authorize', 'authorizeProjectsPr'], ['authorize-admin', 'authorizeAdminProjectsPr']]) {
  for (const flag of ['confirmOwner', 'confirmReview']) {
    test(`invocation capture: ${command} cannot acquire ${flag} mid-call`, { timeout: 90000 }, async t => {
      const f = await prepared(t); const worktree = f.preparedState.worktreePath;
      await fs.writeFile(path.join(worktree, 'proof.txt'), 'worker\n');
      await f.git(['add', 'proof.txt'], worktree); await f.git(['commit', '-m', 'worker'], worktree);
      await surface.finalizeProjectsPr({ repositoryRoot: f.root, packId: 'rehearsal' }, { runner: f.runner });
      const stateBytes = await fs.readFile(f.stateFile); const state = JSON.parse(stateBytes);
      const input = { ...inputFor(f.root), packId: 'rehearsal', reviewedHead: state.verifiedCommit,
        confirmOwner: true, confirmReview: true, [flag]: false };
      let changed = false; let hostedObservations = 0;
      await assert.rejects(surface[method](input, { runner: async call => {
        if (!changed) { changed = true; input[flag] = true; }
        if (call.executable === 'gh') hostedObservations++;
        return f.runner(call);
      } }), { code: 'authorization_confirmation_required' });
      assert.ok(changed); assert.equal(hostedObservations, 0);
      assert.deepEqual(await fs.readFile(f.stateFile), stateBytes);
      await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' });
    });
  }
}
