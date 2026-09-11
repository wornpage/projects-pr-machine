import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createBoundedProcessRunner, createProcessSession, defaultProjectsPrRunner
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/bounded-process.mjs';
import {
  LIFECYCLE_LOCK_NAME, withRepositoryLifecycleLock
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/repository-lock.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/process-tree.mjs', import.meta.url));
const DEADLINE_MS = 5_000;
const TEST_OPTIONS = { timeout: 30_000 };
function within(promise, label, ms = 12_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`Timed out waiting for ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'projects-pr-tree space-'));
  const token = randomUUID();
  const sockets = new Set(); const peers = new Map(); const messages = new Set();
  const changes = new EventEmitter(); const children = []; const kills = [];
  let closing = false; let target; let underlyingCalls = 0; let rawResult;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    if (closing) { socket.destroy(); return; }
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4096) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || value.token !== token || !['controller', 'relay', 'descendant'].includes(value.role)
            || !['ready', 'pong'].includes(value.event) || typeof value.nonce !== 'string'
            || messages.size >= 64) { socket.destroy(); return; }
        if (value.event === 'ready') {
          if (peers.has(value.role)) { socket.destroy(); return; }
          peers.set(value.role, socket);
        } else if (peers.get(value.role) !== socket) { socket.destroy(); return; }
        messages.add(`${value.role}:${value.event}:${value.nonce}`);
        changes.emit('message');
      }
    });
  });
  t.after(async () => {
    // Shutdown is test-owned. Never signal a PID received over the control channel.
    closing = true;
    for (const socket of sockets) socket.destroy(); // Fixtures exit when their control link closes.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child.stdout?.destroy(); child.stderr?.destroy();
    }
    try {
      await Promise.all(children.map(child => within(child.closed, 'fixture cleanup', 4_000)));
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      // Only this test's disposable repository is removed, never a user repository.
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  server.maxConnections = 4;
  server.listen(0, '127.0.0.1');
  await within(once(server, 'listening'), 'loopback listener');
  const port = String(server.address().port);
  const init = await defaultProjectsPrRunner({ executable: 'git', args: ['init', '--quiet', root], timeoutMs: 10_000 });
  assert.equal(init.exitCode, 0, 'disposable Git repository must initialize');
  function observe(child) {
    children.push(child);
    child.closed = new Promise(resolve => child.once('close', (...args) => resolve(args)));
    child.exited = new Promise(resolve => child.once('exit', (...args) => resolve(args)));
    child.on('error', () => {});
    return child;
  }
  const actual = createBoundedProcessRunner({ spawnProcess: (executable, args, options) => {
    // Real spawn, streams, timers, and signals. Only observe the direct-child kill call.
    const child = observe(spawn(executable, args, options));
    if (executable === 'node' && args[0] === FIXTURE) {
      target = child;
      const kill = child.kill.bind(child);
      child.kill = signal => { kills.push(signal); return kill(signal); };
    }
    return child;
  } });
  const session = createProcessSession(async invocation => {
    underlyingCalls++;
    const result = await actual(invocation);
    if (invocation.executable === 'node') rawResult = result;
    return result;
  });
  async function wait(role, event = 'ready', nonce = '') {
    const key = `${role}:${event}:${nonce}`;
    if (messages.has(key)) return;
    let listener;
    try {
      await within(new Promise(resolve => {
        listener = () => { if (messages.has(key)) resolve(); };
        changes.on('message', listener);
        listener();
      }), `${role} ${event}`);
    } finally { changes.off('message', listener); }
  }
  async function ping(role) {
    const nonce = randomUUID();
    peers.get(role).write(`ping:${nonce}\n`);
    await wait(role, 'pong', nonce); // A fresh response proves the fixture is still executing.
  }
  async function stop(role, code = 0) {
    const socket = peers.get(role);
    if (!socket || socket.destroyed) return;
    const closed = once(socket, 'close');
    socket.write(`stop:${code}\n`);
    await within(closed, `${role} control close`, 4_000);
  }
  const lock = path.join(root, '.git', LIFECYCLE_LOCK_NAME);
  const owner = () => fs.readFile(path.join(lock, 'owner.json'));
  const invocation = { executable: 'node', args: [FIXTURE, 'relay', port, token], timeoutMs: DEADLINE_MS };
  return {
    root, lock, owner, wait, ping, stop, session, invocation, kills,
    get target() { return target; }, get rawResult() { return rawResult; },
    get underlyingCalls() { return underlyingCalls; },
    startController: () => observe(spawn('node', [FIXTURE, 'controller', port, token, root], {
      shell: false, windowsHide: true, stdio: 'ignore'
    }))
  };
}

async function refusesReentry(f, owner) {
  let entered = false;
  await assert.rejects(withRepositoryLifecycleLock(f.root, () => { entered = true; },
    { runner: defaultProjectsPrRunner }), { code: 'lifecycle_locked' });
  assert.equal(entered, false);
  assert.deepEqual(await f.owner(), owner, 'reentry must not replace owner evidence');
}

for (const code of [0, 7]) {
  test(`real inherited pipes: parent exit ${code} completes only after descendant closes streams`, TEST_OPTIONS, async t => {
    const f = await setup(t); let settled = false;
    const operation = withRepositoryLifecycleLock(f.root, async () => {
      return f.session.runner(f.invocation);
    }, { runner: f.session.runner, canRelease: f.session.canRelease });
    const outcome = operation.then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    await f.wait('relay'); await f.wait('descendant');
    await f.stop('relay', code);
    assert.deepEqual(await within(f.target.exited, 'direct parent exit'), [code, null]);
    await f.ping('descendant');
    assert.equal(f.rawResult, undefined, 'the runner itself must wait for pipe closure');
    assert.equal(settled, false, 'parent exit is not pipe completion');
    assert.ok((await f.owner()).length > 0, 'lock must remain while descendant holds pipes');
    await f.stop('descendant');
    const value = await within(outcome, 'ordinary completion');
    assert.equal(value.error, undefined);
    assert.equal(value.result.exitCode, code);
    assert.equal(value.result.processUncertain, undefined);
    // Cross-process scheduling must not impose an ordering on independent writes.
    for (const stream of ['stdout', 'stderr']) {
      assert.deepEqual(value.result[stream].trimEnd().split('\n').sort(),
        [`descendant:${stream}`, `relay:${stream}`]);
    }
    assert.deepEqual(f.kills, []); assert.equal(f.session.canRelease(), true);
    await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  });
}

for (const parentExits of [true, false]) {
  test(`real descendant survives deadline: parent ${parentExits ? 'already exited' : 'still running'}, retain lock`, TEST_OPTIONS, async t => {
    const f = await setup(t); let owner;
    const operation = withRepositoryLifecycleLock(f.root, async () => {
      owner = await f.owner();
      await f.session.runner(f.invocation);
      return { status: 'completed' }; // Swallowing a subprocess failure cannot release the lock.
    }, { runner: f.session.runner, canRelease: f.session.canRelease });
    const outcome = operation.then(result => ({ result }), error => ({ error }));
    await f.wait('relay'); await f.wait('descendant');
    if (parentExits) {
      await f.stop('relay');
      assert.deepEqual(await within(f.target.exited, 'parent exit before deadline'), [0, null]);
    }
    await f.ping('descendant');
    const { error, result } = await within(outcome, 'bounded uncertain operation');
    assert.equal(result, undefined);
    assert.equal(error?.code, 'lifecycle_process_uncertain');
    assert.equal(error.operationOutcome, 'unknown');
    assert.deepEqual(f.rawResult, { exitCode: 1, stdout: '', stderr: '',
      terminationReason: 'timeout', processUncertain: true });
    assert.deepEqual(f.kills, parentExits ? [] : ['SIGKILL']);
    assert.equal(f.session.canRelease(), false);
    await f.ping('descendant'); // Not a PID-exists check: actual post-timeout execution.
    await refusesReentry(f, owner);
    const calls = f.underlyingCalls;
    const refused = await f.session.runner({ executable: 'node', args: ['-e', 'process.exit(0)'] });
    assert.equal(refused.terminationReason, 'session_stopped');
    assert.equal(f.underlyingCalls, calls, 'no further subprocess may execute in this session');
    await within(f.target.exited, 'direct-child termination');
    await f.stop('descendant');
    await refusesReentry(f, owner); // Fixture shutdown itself grants no automatic unlock.
  });
}

test('real controller crash retains owner evidence while its child and grandchild still execute', TEST_OPTIONS, async t => {
  const f = await setup(t);
  const controller = f.startController();
  await f.wait('controller'); await f.wait('relay'); await f.wait('descendant');
  const owner = await f.owner();
  assert.equal(JSON.parse(owner).pid, controller.pid);
  assert.equal(controller.kill('SIGKILL'), true);
  await within(controller.exited, 'killed controller exit');
  await f.ping('relay'); await f.ping('descendant');
  await refusesReentry(f, owner);
  await f.stop('descendant'); await f.stop('relay');
  await refusesReentry(f, owner);
});
