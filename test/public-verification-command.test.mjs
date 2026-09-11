import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as surface from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs';
import * as core from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr-core.mjs';
import { withRepositoryLifecycleLock }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/repository-lock.mjs';
import { main } from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs';
import { createFixture, lines, readJson, VERIFY } from './fixtures/local-delivery-harness.mjs';
import { createCodeHandoffAcceptanceSchema }
  from '../integrations/codex/projects-pack-delegation/contracts/code-handoff-acceptance.mjs';

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const inputFor = (repositoryRoot, verificationCommand = VERIFY) => ({ repositoryRoot, packId: 'rehearsal',
  title: 'Command compatibility', baseBranch: 'main', verificationCommand });
const refuses = error => error instanceof surface.ProjectsPrError && error.code === 'invalid_input'
  && !String(error).includes('PRIVATE_COMMAND');
const CLI = fileURLToPath(new URL('../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs', import.meta.url));

for (const command of ['x', 'x'.repeat(500), '😀'.repeat(500), 'echo e\u0301']) {
  test(`public command plan: preserves ${[...command].length} code points and exact hash`, () => {
    const input = inputFor(path.resolve('command-fixture'), command);
    const plan = surface.createProjectsPrPlan(input);
    assert.ok(Object.isFrozen(plan));
    assert.deepEqual(plan, core.createProjectsPrPlan(input));
    assert.equal(plan.verificationCommand, command);
    assert.equal(plan.verificationCommandSha256, digest(command));
  });
}

for (const [label, command] of [
  ['501 code points', 'x'.repeat(501)], ['legacy 2000 units', 'x'.repeat(2000)],
  ['surrounding whitespace', ' PRIVATE_COMMAND '], ['numeric input', 123],
  ['Unicode line separator', 'PRIVATE_COMMAND\u2028x'], ['ill-formed Unicode', 'PRIVATE_COMMAND\ud800']
]) {
  test(`public command boundary: ${label} fails plan and prepare before any I/O`, async () => {
    const input = inputFor(path.resolve('never-created-command-fixture'), command);
    assert.throws(() => surface.createProjectsPrPlan(input), refuses);
    let reads = 0;
    const dependencies = { runner: async () => { reads++; throw new Error('unexpected execution'); },
      fs: new Proxy({}, { get() { reads++; throw new Error('unexpected filesystem access'); } }) };
    await assert.rejects(surface.prepareProjectsPr(input, dependencies), refuses);
    assert.equal(reads, 0);
  });
}

test('public command boundary: an accessor is refused without being evaluated', async () => {
  let reads = 0;
  const input = inputFor(path.resolve('command-fixture'));
  Object.defineProperty(input, 'verificationCommand', { get() { reads++; return VERIFY; } });
  assert.throws(() => surface.createProjectsPrPlan(input), refuses);
  await assert.rejects(surface.prepareProjectsPr(input), refuses);
  assert.equal(reads, 0);
});

for (const command of ['PRIVATE_COMMAND'.padEnd(501, 'x'), ' PRIVATE_COMMAND', 'PRIVATE_COMMAND\u2028x']) {
  test('CLI prepare: incompatible command returns one redacted invalid-input receipt without I/O', async () => {
    const out = []; const errors = []; let calls = 0;
    const code = await main(['prepare', '--pack-id', 'rehearsal', '--title', 'Command compatibility',
      '--base', 'main', '--verify-command', command],
    { log: value => out.push(value), error: value => errors.push(value) },
    { runner: async () => { calls++; throw new Error('must not run'); } });
    assert.equal(code, 1); assert.deepEqual(out, []); assert.equal(errors.length, 1);
    const receipt = JSON.parse(errors[0]);
    assert.equal(receipt.command, 'prepare'); assert.equal(receipt.status, 'failed');
    assert.equal(receipt.error.code, 'invalid_input'); assert.equal(calls, 0);
    assert.ok(!errors[0].includes('PRIVATE_COMMAND'));
  });
}

test('real CLI process: rejects oversize before creating a repository or executing command text', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'command-boundary-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = 'echo PRIVATE_COMMAND > should-not-exist'.padEnd(501, 'x');
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [CLI, 'prepare', '--repo', path.join(directory, 'missing'),
    '--pack-id', 'rehearsal', '--title', 'Command compatibility', '--base', 'main', '--verify-command', command],
  { cwd: directory, env, shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 1);
  assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).error.code, 'invalid_input');
  assert.ok(!result.stderr.includes('PRIVATE_COMMAND')); assert.deepEqual(await fs.readdir(directory), []);
});

test('prepare snapshots the validated plan before asynchronous lock discovery', { timeout: 90000 }, async t => {
  const f = await createFixture(t);
  const input = inputFor(f.root); let changed = false;
  const receipt = await surface.prepareProjectsPr(input, { runner: async call => {
    if (!changed) {
      changed = true;
      input.verificationCommand = 'PRIVATE_COMMAND'.padEnd(600, 'x');
      input.title = 'Changed after validation';
    }
    return f.runner(call);
  } });
  assert.equal(changed, true); assert.equal(receipt.status, 'prepared');
  assert.equal(receipt.plan.verificationCommandSha256, digest(VERIFY));
  assert.equal(Object.hasOwn(receipt.plan, 'verificationCommand'), false);
  const state = await readJson(f.stateFile);
  assert.equal(state.verificationCommand, VERIFY); assert.equal(state.verificationCommandSha256, digest(VERIFY));
  assert.equal(state.title, 'Command compatibility');
  assert.deepEqual(await lines(f.verificationFile), []);
  assert.deepEqual((await readJson(f.serviceFile)).pulls, []);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  assert.equal((await surface.abortProjectsPr(inputFor(f.root), { runner: f.runner })).status, 'aborted');
});

for (const length of [600, 2000]) {
  test(`legacy ${length}-unit state remains observable and safely abortable without rewriting its command`, { timeout: 90000 }, async t => {
    const f = await createFixture(t); const command = 'x'.repeat(length);
    // Only the trusted test fixture uses private core to reproduce a pre-WP-02c
    // preparation. Production entry points must never use this as a bypass.
    const prepared = await withRepositoryLifecycleLock(f.root,
      () => core.prepareProjectsPr(inputFor(f.root, command), { runner: f.runner }), { runner: f.runner });
    assert.equal(prepared.status, 'prepared');
    const original = await fs.readFile(f.stateFile);
    const state = JSON.parse(original);
    assert.equal(state.verificationCommand, command); assert.equal(state.verificationCommandSha256, digest(command));
    assert.throws(() => surface.createProjectsPrPlan(inputFor(f.root, command)), refuses);
    assert.throws(() => createCodeHandoffAcceptanceSchema({ packId: 'rehearsal', workerId: 'worker', verificationCommand: command }),
      { code: 'verification_command_too_long' });
    const status = await surface.statusProjectsPr({ repositoryRoot: f.root, packId: 'rehearsal' }, { runner: f.runner });
    assert.equal(status.status, 'observed'); assert.equal(status.state.phase, 'prepared');
    assert.deepEqual(await fs.readFile(f.stateFile), original);
    await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
    const abort = await surface.abortProjectsPr({ repositoryRoot: f.root, packId: 'rehearsal' }, { runner: f.runner });
    assert.equal(abort.status, 'aborted');
    assert.equal((await readJson(f.stateFile)).verificationCommand, command);
    assert.deepEqual(await lines(f.verificationFile), []);
    assert.deepEqual((await readJson(f.serviceFile)).pulls, []);
  });
}
