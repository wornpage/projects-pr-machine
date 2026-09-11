import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as surface from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs';
import * as core from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr-core.mjs';
import { main } from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs';

const methods = {
  prepare: 'prepareProjectsPr', finalize: 'finalizeProjectsPr', abort: 'abortProjectsPr',
  stack: 'stackProjectsPr', authorize: 'authorizeProjectsPr',
  'authorize-admin': 'authorizeAdminProjectsPr', finish: 'finishProjectsPr'
};
async function fixture(t) {
  const repositoryRoot = await fs.mkdtemp(path.join(tmpdir(), 'projects-pr-lock-entry-'));
  await fs.mkdir(path.join(repositoryRoot, '.git'));
  t.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  return { repositoryRoot, lockPath: path.join(repositoryRoot, '.git', 'projects-pr-v2.lock'),
    input: { repositoryRoot, packId: 'pack-1', packIds: ['pack-1', 'pack-2'], title: 'Lock test',
      baseBranch: 'main', verificationCommand: 'PRIVATE_COMMAND', reviewedHead: 'b'.repeat(40),
      confirmReview: true, confirmOwner: true, reason: 'fixture', bypassedRequirements: ['github-ruleset:update'] } };
}
function discovery(f) {
  let calls = 0;
  return { get calls() { return calls; }, runner: async call => {
    calls++;
    assert.equal(call.executable, 'git'); assert.equal(call.shell, false);
    assert.equal(call.timeoutMs, 10000);
    assert.equal(call.args.join(' '), calls === 1 ? 'rev-parse --show-toplevel' : 'rev-parse --git-common-dir');
    return { exitCode: 0, stdout: calls === 1 ? `${f.repositoryRoot}\n` : '.git\n' };
  } };
}

test('public API exports remain identical except for the seven locked mutations', () => {
  assert.deepEqual(Object.keys(surface).sort(), Object.keys(core).sort());
  for (const name of Object.keys(core)) {
    if (Object.values(methods).includes(name)) assert.notEqual(surface[name], core[name]);
    else assert.equal(surface[name], core[name], `${name} must retain its identity`);
  }
});

for (const [command, method] of Object.entries(methods)) {
  test(`${command}: public entry point refuses contention before entering core`, async t => {
    const f = await fixture(t); await fs.mkdir(f.lockPath);
    await fs.writeFile(path.join(f.lockPath, 'sentinel'), 'unchanged');
    const read = discovery(f);
    await assert.rejects(surface[method](f.input, { runner: read.runner }), e => {
      assert.ok(e instanceof surface.ProjectsPrError); assert.equal(e.code, 'lifecycle_locked');
      assert.equal(e.receipt.command, command); assert.equal(e.receipt.operationOutcome, 'not_started');
      assert.equal(e.receipt.recovery.nextCommand, 'status');
      assert.ok(!JSON.stringify(e.receipt).includes('PRIVATE_COMMAND')); return true;
    });
    assert.equal(read.calls, 2);
    assert.equal(await fs.readFile(path.join(f.lockPath, 'sentinel'), 'utf8'), 'unchanged');
    assert.deepEqual(await fs.readdir(path.join(f.repositoryRoot, '.git')), ['projects-pr-v2.lock']);
  });
  test(`${command}: lock exists during core entry and is released when core fails`, async t => {
    const f = await fixture(t); const read = discovery(f); let entered = false;
    const runner = async call => {
      if (read.calls < 2) return read.runner(call);
      entered = true; assert.ok((await fs.stat(path.join(f.lockPath, 'owner.json'))).isFile());
      throw new Error('intentional core fixture failure');
    };
    await assert.rejects(surface[method](f.input, { runner, nodeVersion: '22.0.0' }));
    assert.equal(entered, true); await assert.rejects(fs.lstat(f.lockPath), { code: 'ENOENT' });
  });
}

test('CLI uses the same public mutation lock and returns a nonzero bounded receipt', async t => {
  const f = await fixture(t); await fs.mkdir(f.lockPath); const read = discovery(f);
  const out = []; const errors = [];
  const code = await main(['finalize', '--repo', f.repositoryRoot, '--pack-id', 'pack-1'],
    { log: value => out.push(value), error: value => errors.push(value) }, { runner: read.runner });
  assert.equal(code, 1); assert.deepEqual(out, []); assert.equal(errors.length, 1);
  const receipt = JSON.parse(errors[0]); assert.equal(receipt.error.code, 'lifecycle_locked');
  assert.equal(receipt.command, 'finalize'); assert.equal(read.calls, 2);
});

test('doctor and status remain lock-free read-only entry points', async t => {
  const f = await fixture(t); await fs.mkdir(f.lockPath);
  assert.equal(surface.runProjectsPrDoctor, core.runProjectsPrDoctor);
  assert.equal(surface.statusProjectsPr, core.statusProjectsPr);
  const doctor = await surface.runProjectsPrDoctor({ repositoryRoot: f.repositoryRoot }, {
    nodeVersion: '22.0.0', runner: async () => ({ exitCode: 127, stdout: '', stderr: '' })
  });
  assert.equal(doctor.status, 'unavailable');
  await assert.rejects(surface.statusProjectsPr(f.input, { runner: async call => ({ exitCode: 0,
    stdout: call.args.includes('--show-toplevel') ? `${f.repositoryRoot}\n` : '.git\n' }) }),
  e => e.code === 'state_not_found');
  assert.deepEqual(await fs.readdir(f.lockPath), []);
  assert.deepEqual(await fs.readdir(path.join(f.repositoryRoot, '.git')), ['projects-pr-v2.lock']);
});

test('package and CLI resolve the locked public boundary, with no unlock flag', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['.'], './integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs');
  const cli = await fs.readFile(new URL('../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs', import.meta.url), 'utf8');
  assert.match(cli, /from '\.\/lib\/projects-pr\.mjs'/u);
  assert.doesNotMatch(cli, /projects-pr-core|--force-unlock|--skip-lock/u);
});

for (const [command, method] of Object.entries(methods)) {
  test(`${command}: missing pack identifiers retain invalid_input without I/O`, async () => {
    let calls = 0;
    await assert.rejects(surface[method]({}, { runner: async () => { calls++; } }),
      e => e instanceof surface.ProjectsPrError && e.code === 'invalid_input');
    assert.equal(calls, 0);
  });
}
