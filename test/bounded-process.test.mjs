import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  createBoundedProcessRunner, createProcessSession, defaultProjectsPrRunner,
  processOptions, PROCESS_TIMEOUT_MS, VERIFICATION_TIMEOUT_MS, PROCESS_OUTPUT_BYTES
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/bounded-process.mjs';
import { withRepositoryLifecycleLock, LIFECYCLE_LOCK_NAME } from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/repository-lock.mjs';

function fake() {
  const child = new EventEmitter();
  child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.kill = signal => { child.kills.push(signal); return true; };
  child.unrefs = 0; child.unref = () => { child.unrefs++; };
  const calls = []; const timers = [];
  const run = createBoundedProcessRunner({
    spawnProcess: (...args) => { calls.push(args); return child; },
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; }
  });
  return { child, calls, timers, run };
}
const invocation = { executable: 'node', args: ['-e', '0'] };

test('default deadlines and both platform shell mappings preserve the literal command', () => {
  assert.equal(PROCESS_TIMEOUT_MS, 30_000); assert.equal(VERIFICATION_TIMEOUT_MS, 900_000);
  assert.equal(PROCESS_OUTPUT_BYTES, 1_048_576);
  const command = 'echo "literal $VALUE; marker"';
  assert.equal(processOptions(invocation).timeoutMs, 30_000);
  for (const platform of ['linux', 'win32']) {
    const spec = processOptions({ executable: command, shell: true }, platform);
    assert.equal(spec.timeoutMs, 900_000);
    assert.equal(spec.executable, platform === 'win32' ? 'pwsh' : '/bin/sh');
    assert.deepEqual(spec.args, platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]);
  }
});
for (const ms of [1, 10_000, 30_000, 900_000]) {
  test(`honors the explicit ${ms} ms deadline including spawn-to-stdio completion`, async () => {
    const f = fake(); const p = f.run({ ...invocation, timeoutMs: ms });
    assert.equal(f.timers[0].ms, ms);
    f.child.emit('spawn'); f.child.emit('exit', 0, null);
    assert.equal(f.timers[0].cleared, false);
    f.child.emit('close', 0, null);
    assert.equal((await p).exitCode, 0); assert.equal(f.timers[0].cleared, true);
    assert.deepEqual(f.child.kills, []);
  });
}
for (const ms of [0, -1, NaN, Infinity, 0.5, '30000', null, 900_001, 2 ** 31]) {
  test(`rejects invalid explicit timeout ${String(ms)} without starting a subprocess`, async () => {
    const f = fake(); const result = await f.run({ ...invocation, timeoutMs: ms });
    assert.equal(result.exitCode, 1); assert.equal(result.terminationReason, 'invalid_invocation');
    assert.equal(result.processUncertain, false); assert.equal(f.calls.length, 0);
  });
}
for (const value of [null, [], {}, { executable: '' }, { executable: 'a\0b' },
  { executable: 'node', args: [1] }, { executable: 'node', args: ['\0'] },
  { executable: 'node', shell: 'true' }, { executable: 'node', cwd: 3 }]) {
  test(`invalid invocation fails without reflecting it: ${JSON.stringify(value)}`, async () => {
    const f = fake(); assert.equal((await f.run(value)).terminationReason, 'invalid_invocation');
    assert.equal(f.calls.length, 0);
  });
}

test('non-shell arguments are passed literally with ignored stdin and no implicit shell', async () => {
  const f = fake(); const args = ['x; PRIVATE', '$(touch nope)', 'a b'];
  const p = f.run({ executable: 'tool', args, cwd: '/fixture' });
  args[0] = 'changed';
  assert.deepEqual(f.calls[0], ['tool', ['x; PRIVATE', '$(touch nope)', 'a b'], {
    cwd: '/fixture', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }]);
  f.child.emit('close', 0, null); await p;
});
for (const code of [0, 1, 7, 127]) {
  test(`normal exit ${code} preserves both streams and does not signal`, async () => {
    const f = fake(); const p = f.run(invocation); const utf = Buffer.from('a😀z');
    f.child.stdout.emit('data', utf.subarray(0, 3)); f.child.stdout.emit('data', utf.subarray(3));
    f.child.stderr.emit('data', Buffer.from('diagnostic'));
    f.child.emit('exit', code, null); f.child.emit('close', code, null);
    assert.deepEqual(await p, { exitCode: code, stdout: 'a😀z', stderr: 'diagnostic' });
    assert.deepEqual(f.child.kills, []); assert.equal(f.timers[0].cleared, true);
  });
}
for (const stream of ['stdout', 'stderr']) {
  test(`${stream}: exact byte cap succeeds but one more byte is uncertain and discards output`, async () => {
    const f = fake(); const p = f.run(invocation);
    f.child[stream].emit('data', Buffer.alloc(PROCESS_OUTPUT_BYTES, 120));
    f.child.emit('close', 0, null);
    assert.equal((await p)[stream].length, PROCESS_OUTPUT_BYTES);
    const g = fake(); const q = g.run(invocation);
    g.child[stream].emit('data', Buffer.alloc(PROCESS_OUTPUT_BYTES, 120));
    g.child[stream].emit('data', Buffer.from('!'));
    assert.deepEqual(await q, { exitCode: 1, stdout: '', stderr: '', terminationReason: 'output_limit', processUncertain: true });
    assert.deepEqual(g.child.kills, ['SIGKILL']); assert.equal(g.child.unrefs, 1);
    assert.ok(g.child.stdout.destroyed && g.child.stderr.destroyed);
  });
}

test('deadline discards partial output, signals only once, and ignores late success', async () => {
  const f = fake(); const p = f.run(invocation);
  f.child.stdout.emit('data', Buffer.from('PRIVATE_COMMAND_TOKEN'));
  f.timers[0].callback(); f.timers[0].callback();
  f.child.emit('error', Error('PRIVATE')); f.child.emit('exit', 0, null); f.child.emit('close', 0, null);
  const result = await p;
  assert.equal(result.terminationReason, 'timeout'); assert.equal(result.processUncertain, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.deepEqual(f.child.kills, ['SIGKILL']); assert.equal(f.child.unrefs, 1);
});

test('exited child with inherited pipes still reaches the deadline, without signaling its old PID', async () => {
  const f = fake(); const p = f.run(invocation);
  f.child.emit('spawn'); f.child.emit('exit', 0, null); f.timers[0].callback();
  assert.equal((await p).terminationReason, 'timeout');
  assert.deepEqual(f.child.kills, []); assert.ok(f.child.stdout.destroyed);
});
for (const kill of [() => false, () => { throw Error('PRIVATE kill error'); }]) {
  test('failed direct-child termination still returns uncertainty without waiting forever', async () => {
    const f = fake(); f.child.kill = kill; const p = f.run(invocation); f.timers[0].callback();
    const result = await p; assert.equal(result.processUncertain, true);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  });
}
for (const event of ['signal', 'stream_error', 'process_error', 'invalid_close']) {
  test(`${event} cannot become an ordinary successful completion`, async () => {
    const f = fake(); const p = f.run(invocation); f.child.emit('spawn');
    if (event === 'signal') f.child.emit('exit', null, 'SIGTERM');
    if (event === 'stream_error') f.child.stderr.emit('error', Error('PRIVATE'));
    if (event === 'process_error') f.child.emit('error', Error('PRIVATE'));
    if (event === 'invalid_close') f.child.emit('close', null, null);
    const result = await p; assert.equal(result.processUncertain, true); assert.equal(result.exitCode, 1);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  });
}

test('spawn failures before a child exists need no uncertain-process lock', async () => {
  const run = createBoundedProcessRunner({ spawnProcess: () => { throw Error('PRIVATE'); } });
  assert.deepEqual(await run(invocation), { exitCode: 1, stdout: '', stderr: '', terminationReason: 'spawn_failed', processUncertain: false });
  const f = fake(); f.child.pid = undefined; const p = f.run(invocation);
  f.child.emit('error', Error('PRIVATE')); f.child.emit('close', -2, null);
  assert.equal((await p).processUncertain, false); assert.deepEqual(f.child.kills, []);
});

test('session uncertainty is latched, rejects contradictory success, and suppresses later executions', async () => {
  let calls = 0; const session = createProcessSession(async () => {
    calls++; return { exitCode: 0, stdout: 'PRIVATE partial success', processUncertain: true };
  });
  assert.equal(session.canRelease(), true);
  const result = await session.runner(invocation); assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, ''); assert.equal(session.canRelease(), false);
  await session.runner(invocation); await session.runner(invocation); assert.equal(calls, 1);
});

test('ordinary results and trusted injected exceptions preserve existing error behavior', async () => {
  const expected = { exitCode: 9, stdout: 'out', stderr: 'err' };
  const session = createProcessSession(async () => expected);
  assert.equal(await session.runner(invocation), expected); assert.equal(session.canRelease(), true);
  const error = Error('fixture'); const failed = createProcessSession(async () => { throw error; });
  await assert.rejects(failed.runner(invocation), value => value === error);
  assert.equal(failed.canRelease(), true);
});

test('real child exits preserve code/output and close unused stdin', { timeout: 10_000 }, async () => {
  const result = await defaultProjectsPrRunner({ executable: 'node', args: ['-e',
    "process.stdin.resume(); process.stdin.on('end',()=>{process.stdout.write('out');process.stderr.write('err');process.exitCode=7;});"], timeoutMs: 5_000 });
  assert.deepEqual(result, { exitCode: 7, stdout: 'out', stderr: 'err' });
});

test('real direct-child timeout is bounded, does not expose partial output, and requests termination', { timeout: 10_000 }, async () => {
  let child; let closed;
  const run = createBoundedProcessRunner({ spawnProcess: (...args) => {
    child = spawn(...args); closed = new Promise(resolve => child.once('close', resolve)); return child;
  } });
  const started = Date.now();
  const result = await run({ executable: 'node', args: ['-e',
    "process.on('SIGTERM',()=>{}); process.stdout.write('PRIVATE'); setInterval(()=>{},1000);"], timeoutMs: 300 });
  assert.equal(result.terminationReason, 'timeout'); assert.equal(result.processUncertain, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(Date.now() - started < 5_000);
  child.ref(); // The test, not the runner, waits for proof of direct-child exit.
  await closed; assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('real output overflow cannot produce a successful truncated result', { timeout: 10_000 }, async () => {
  const result = await defaultProjectsPrRunner({ executable: 'node',
    args: ['-e', `process.stdout.write(Buffer.alloc(${PROCESS_OUTPUT_BYTES + 1}));`], timeoutMs: 5_000 });
  assert.equal(result.terminationReason, 'output_limit'); assert.equal(result.stdout, '');
  assert.equal(result.processUncertain, true);
});

test('real spawn error is bounded and redacted', async () => {
  const result = await defaultProjectsPrRunner({ executable: 'projects-pr-PRIVATE-missing-command-4926', timeoutMs: 500 });
  assert.equal(result.terminationReason, 'spawn_failed'); assert.equal(result.processUncertain, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

async function repository(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'projects-pr-timeout-'));
  execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, lock: path.join(root, '.git', LIFECYCLE_LOCK_NAME) };
}
for (const outcome of ['returned', 'threw', 'real-timeout']) {
  test(`uncertain ${outcome} operation retains exact owner bytes and blocks reacquisition`, { timeout: 10_000 }, async t => {
    const f = await repository(t); let owner;
    const session = createProcessSession();
    let certain = true;
    const options = { runner: session.runner, canRelease: () => certain && session.canRelease() };
    await assert.rejects(withRepositoryLifecycleLock(f.root, async () => {
      owner = await fs.readFile(path.join(f.lock, 'owner.json'));
      if (outcome === 'real-timeout') {
        await session.runner({ executable: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 });
      } else {
        certain = false;
      }
      if (outcome === 'threw') throw Error('PRIVATE operation error');
      return { status: 'completed' }; // Core swallowing a failure must not permit release.
    }, options), error => {
      assert.equal(error.code, 'lifecycle_process_uncertain'); assert.equal(error.operationOutcome, 'unknown');
      assert.ok(!error.message.includes('PRIVATE')); return true;
    });
    assert.deepEqual(await fs.readFile(path.join(f.lock, 'owner.json')), owner);
    let entered = false;
    await assert.rejects(withRepositoryLifecycleLock(f.root, () => { entered = true; }, { runner: defaultProjectsPrRunner }),
      { code: 'lifecycle_locked' });
    assert.equal(entered, false); assert.deepEqual(await fs.readFile(path.join(f.lock, 'owner.json')), owner);
  });
}
for (const guard of [() => false, () => undefined, () => 'true', () => { throw Error('PRIVATE'); }, async () => true]) {
  test('release requires exact synchronous true; failed or ambiguous guard preserves evidence', async t => {
    const f = await repository(t);
    await assert.rejects(withRepositoryLifecycleLock(f.root, () => 1, { runner: defaultProjectsPrRunner, canRelease: guard }),
      { code: 'lifecycle_process_uncertain' });
    assert.deepEqual(await fs.readdir(f.lock), ['owner.json']);
  });
}

test('normal completed and ordinary failed operations still release their owned lock', async t => {
  const f = await repository(t); const options = { runner: defaultProjectsPrRunner, canRelease: () => true };
  assert.equal(await withRepositoryLifecycleLock(f.root, () => 42, options), 42);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  const expected = Error('normal failure');
  await assert.rejects(withRepositoryLifecycleLock(f.root, () => { throw expected; }, options), e => e === expected);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

test('real platform verification shell preserves its completed nonzero exit', { timeout: 10_000 }, async () => {
  assert.deepEqual(await defaultProjectsPrRunner({ executable: 'exit 7', shell: true, timeoutMs: 5_000 }),
    { exitCode: 7, stdout: '', stderr: '' });
});

// Regression coverage for the executable-path autofix, not a sandbox or PATH policy.
for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform}: raw non-shell executable validation refuses path aliases and metacharacters`, () => {
    for (const executable of [
      '/usr/bin/node', 'C:/tools/node.exe', 'C:\\tools\\node.exe', 'C:node',
      './node', '../node', 'x/../node', 'x/./../node', '.\\node', '..\\node',
      '//server/share/node', '\\\\server\\share\\node', '/bin/./sh', '/bin//sh',
      '.', '..', ' node', 'node ', 'node\n', 'node\t', 'node;echo', '$(node)',
      'node|other', 'node&other', '"node"', "'node'", 'node:stream'
    ]) {
      assert.throws(() => processOptions({ executable }, platform), `refuse ${JSON.stringify(executable)}`);
    }
    for (const executable of ['git', 'gh', 'pwsh', 'node', 'node.exe', 'tool-name_1.2']) {
      assert.deepEqual(processOptions({ executable, args: ['literal;argument'] }, platform), {
        executable, args: ['literal;argument'], cwd: undefined, timeoutMs: PROCESS_TIMEOUT_MS
      });
    }
  });
}

test('the exact Unix doctor shell is allowed without widening other absolute paths', () => {
  for (const platform of ['linux', 'darwin']) {
    const args = ['-c', 'exit 0'];
    assert.deepEqual(processOptions({ executable: '/bin/sh', args, shell: false }, platform), {
      executable: '/bin/sh', args, cwd: undefined, timeoutMs: PROCESS_TIMEOUT_MS
    });
  }
  assert.throws(() => processOptions({ executable: '/bin/sh', shell: false }, 'win32'));
});

test('rejected raw paths never reach spawn and diagnostics omit the input', async () => {
  for (const executable of ['/PRIVATE/tool', './PRIVATE-tool', 'x/../PRIVATE-tool', 'C:PRIVATE-tool']) {
    const f = fake();
    const pending = f.run({ executable });
    assert.equal(f.calls.length, 0); assert.equal(f.timers.length, 0);
    assert.deepEqual(await pending, {
      exitCode: 1, stdout: '', stderr: '', terminationReason: 'invalid_invocation', processUncertain: false
    });
  }
});

test('path-like arguments remain literal data and are not restricted as executables', async () => {
  const f = fake(); const args = ['-C', '/work tree/PRIVATE;$(data)', 'status'];
  const p = f.run({ executable: 'git', args });
  assert.equal(f.calls[0][0], 'git'); assert.deepEqual(f.calls[0][1], args);
  assert.equal(f.calls[0][2].shell, false);
  f.child.emit('close', 0, null); assert.equal((await p).exitCode, 0);
});

test('intentional owner verification text bypasses filename validation but not deadline policy', () => {
  const command = './verify "/work tree/input" && echo "$VALUE"';
  for (const platform of ['linux', 'darwin', 'win32']) {
    const spec = processOptions({ executable: command, shell: true }, platform);
    assert.equal(spec.timeoutMs, VERIFICATION_TIMEOUT_MS);
    assert.equal(spec.executable, platform === 'win32' ? 'pwsh' : '/bin/sh');
    assert.equal(spec.args.at(-1), command);
    assert.throws(() => processOptions({ executable: command, shell: true, timeoutMs: 0 }, platform));
  }
});
