// Test-only local transport. Never use this adapter for a real repository.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoundedProcessRunner }
  from '../../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/bounded-process.mjs';

export const REPOSITORY = 'fixture/local-delivery';
export const VERIFY = 'node verify.mjs';
const DRIVER = fileURLToPath(new URL('./local-delivery-cli.mjs', import.meta.url));
const ok = value => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const denied = () => ({ exitCode: 1, stdout: '', stderr: 'fixture_refused' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const topic = value => typeof value === 'string' && /^projects-pr\/[a-z0-9-]+$/u.test(value);
const ref = value => value === 'refs/heads/main' || (value?.startsWith('refs/heads/') && topic(value.slice(11)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function isolatedEnvironment(directory, inherited = process.env) {
  const env = {};
  // Deliberately do not inherit NODE_OPTIONS, GIT_*, tokens, or SSH agent settings.
  for (const [key, value] of Object.entries(inherited)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|lang|lc_all)$/iu.test(key)) env[key] = value;
  }
  Object.assign(env, { HOME: path.join(directory, 'home'), USERPROFILE: path.join(directory, 'home'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never', GIT_ALLOW_PROTOCOL: 'file',
    LOCAL_DELIVERY_VERIFY_LOG: path.join(directory, 'verification.jsonl') });
  const config = { 'protocol.allow': 'never', 'protocol.file.allow': 'always',
    'core.hooksPath': path.join(directory, 'no-hooks'), 'core.fsmonitor': 'false',
    'core.autocrlf': 'false', 'core.safecrlf': 'false', 'commit.gpgSign': 'false',
    'tag.gpgSign': 'false', 'user.name': 'Local rehearsal', 'user.email': 'rehearsal@example.invalid' };
  env.GIT_CONFIG_COUNT = String(Object.keys(config).length);
  Object.entries(config).forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function writeJson(file, value) { await fs.writeFile(file, `${JSON.stringify(value)}\n`); }
export async function lines(file) {
  try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export function localProcessRunner(directory) {
  const env = isolatedEnvironment(directory);
  return createBoundedProcessRunner({ spawnProcess: (executable, args, options) =>
    spawn(executable, args, { ...options, env }) });
}

export async function openFixture(directory) {
  const canonical = await fs.realpath(directory);
  const manifest = await readJson(path.join(canonical, 'fixture.json'));
  assert.equal(manifest.kind, 'local-delivery-rehearsal');
  assert.equal(manifest.directory, canonical);
  const root = path.join(canonical, 'checkout');
  const remote = path.join(canonical, 'origin.git');
  const worktreeRoot = path.join(canonical, '.projects-pr-worktrees');
  const lock = path.join(root, '.git', 'projects-pr-v2.lock');
  const serviceFile = path.join(canonical, 'service.json');
  const auditFile = path.join(canonical, 'audit.jsonl');
  const run = localProcessRunner(canonical);
  async function audit(event, fields = {}) {
    await fs.appendFile(auditFile, `${JSON.stringify({ event, pid: process.pid, ...fields })}\n`);
  }
  async function git(args, cwd = root) {
    const result = await run({ executable: 'git', args, cwd, shell: false, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0, `Fixture Git failed: ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  }
  const isWorktree = value => typeof value === 'string' && path.dirname(value) === worktreeRoot
    && /^checkout-[a-z0-9-]+$/u.test(path.basename(value));
  const allowedCwd = value => value === root || isWorktree(value);
  async function localOrigin() {
    // These fixture repositories are trusted; still refuse transport drift before dispatch.
    const urls = await git(['config', '--get-all', 'remote.origin.url']);
    const push = await run({ executable: 'git', args: ['config', '--get-all', 'remote.origin.pushurl'],
      cwd: root, shell: false, timeoutMs: 10_000 });
    return urls === remote && push.exitCode === 1;
  }
  function allowedGit(args, cwd) {
    const [command, a, b, c, d, e] = args;
    if ([['--version'], ['rev-parse', '--show-toplevel'], ['rev-parse', '--git-common-dir'],
      ['status', '--porcelain=v1', '--untracked-files=normal'], ['branch', '--show-current'],
      ['worktree', 'list', '--porcelain'], ['rev-parse', 'HEAD'],
      ['rev-parse', '--verify', 'refs/heads/main'], ['rev-parse', 'refs/heads/main']]
      .some(expected => same(args, expected))) return true;
    if (command === 'for-each-ref' && a === '--format=%(objectname)' && ref(b) && args.length === 3) return true;
    if (command === 'ls-remote' && a === '--heads' && b === 'origin' && ref(c) && args.length === 4) return true;
    if (command === 'push' && a === '--set-upstream' && b === 'origin'
      && c?.startsWith('HEAD:refs/heads/') && topic(c.slice(16)) && args.length === 4 && isWorktree(cwd)) return true;
    if (command === 'worktree' && a === 'add' && b === '-b' && topic(c)
      && isWorktree(d) && oid(e) && args.length === 6 && cwd === root) return true;
    if (command === 'worktree' && a === 'remove' && isWorktree(b) && args.length === 3 && cwd === root) return true;
    if (command === 'branch' && a === '-d' && topic(b) && args.length === 3 && cwd === root) return true;
    if (command === 'merge-base' && a === '--is-ancestor' && oid(b) && oid(c) && args.length === 4) return true;
    return command === 'rev-list' && a === '--count' && /^[a-f0-9]{40}\.\.[a-f0-9]{40}$/u.test(b) && args.length === 3;
  }
  async function ownerEvidence() {
    const bytes = await fs.readFile(path.join(lock, 'owner.json'));
    assert.equal(JSON.parse(bytes).pid, process.pid, 'effects must hold this CLI process lock');
    return hash(bytes);
  }
  async function consumeFault(name) {
    const service = await readJson(serviceFile);
    if (service.fault !== name) return false;
    service.fault = null; await writeJson(serviceFile, service); return true;
  }
  async function gh(args) {
    if (same(args, ['--version'])) return ok('gh version 0.0.0 (local stand-in)\n');
    if (same(args, ['auth', 'status', '--hostname', 'github.com'])) return ok('');
    if (same(args, ['api', '--hostname', 'github.com', `repos/${REPOSITORY}`,
      '--jq', '{fullName: .full_name, push: .permissions.push}'])) return ok({ fullName: REPOSITORY, push: true });
    const service = await readJson(serviceFile);
    if (args.length === 10 && same(args.slice(0, 4), ['pr', 'list', '--repo', `github.com/${REPOSITORY}`])
      && args[4] === '--head' && topic(args[5]) && same(args.slice(6), ['--state', 'all', '--json', 'number,url'])) {
      return ok(service.pulls.filter(pr => pr.head.ref === args[5]).map(pr => ({ number: pr.number, url: pr.html_url })));
    }
    if (args.length === 4 && same(args.slice(0, 3), ['api', '--hostname', 'github.com'])
      && /^repos\/fixture\/local-delivery\/pulls\/[1-9][0-9]*$/u.test(args[3])) {
      const pr = service.pulls.find(item => item.number === Number(args[3].split('/').at(-1)));
      return pr ? ok(pr) : denied();
    }
    if (args.length === 13 && same(args.slice(0, 5), ['pr', 'create', '--repo', `github.com/${REPOSITORY}`, '--draft'])
      && args[5] === '--base' && args[6] === 'main' && args[7] === '--head' && topic(args[8])
      && args[9] === '--title' && typeof args[10] === 'string' && args[10].length <= 200
      && args[11] === '--body' && typeof args[12] === 'string' && args[12].length <= 4096) {
      const ownerSha256 = await ownerEvidence();
      const head = await git(['rev-parse', `refs/heads/${args[8]}`], remote);
      assert.ok(oid(head));
      const number = service.pulls.length + 1;
      const pr = { number, html_url: `https://github.com/${REPOSITORY}/pull/${number}`, draft: true, state: 'open',
        base: { ref: 'main', repo: { full_name: REPOSITORY } },
        head: { ref: args[8], sha: head, repo: { full_name: REPOSITORY } } };
      service.pulls.push(pr); await writeJson(serviceFile, service);
      await audit('create-effect', { head, number, ownerSha256 });
      if (await consumeFault('pr-response-lost')) return denied();
      return ok(`${pr.html_url}\n`);
    }
    await audit('blocked', { executable: 'gh' });
    return denied();
  }
  const runner = async invocation => {
    const { executable, args = [], cwd, shell = false } = invocation ?? {};
    if (!Array.isArray(args) || args.some(item => typeof item !== 'string') || !allowedCwd(cwd)) {
      await audit('blocked'); return denied();
    }
    await audit('invoke', { executable, args, cwd, shell });
    if (shell === true) {
      if (executable !== VERIFY || args.length || !isWorktree(cwd)) { await audit('blocked'); return denied(); }
      await ownerEvidence();
      return run(invocation);
    }
    if (shell !== false) { await audit('blocked'); return denied(); }
    if (executable === 'gh') return gh(args);
    if ((executable === '/bin/sh' && same(args, ['-c', 'exit 0']))
      || (executable === 'pwsh' && same(args, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']))) return run(invocation);
    if (executable !== 'git') { await audit('blocked'); return denied(); }
    if (['remote', 'ls-remote', 'push'].includes(args[0]) && !(await localOrigin())) { await audit('blocked'); return denied(); }
    if (same(args, ['remote', 'get-url', 'origin'])) return ok(`https://github.com/${REPOSITORY}.git\n`);
    if (!allowedGit(args, cwd)) { await audit('blocked'); return denied(); }
    const effect = args[0] === 'push' || (args[0] === 'worktree' && args[1] !== 'list')
      || (args[0] === 'branch' && args[1] === '-d');
    const ownerSha256 = effect ? await ownerEvidence() : null;
    const result = await run(invocation);
    if (args[0] === 'push' && result.exitCode === 0) {
      await audit('push-effect', { head: await git(['rev-parse', 'HEAD'], cwd), ownerSha256 });
      if (await consumeFault('push-response-lost')) return denied();
      if (await consumeFault('push-uncertain')) return { ...denied(), processUncertain: true };
    }
    return result;
  };
  return { directory: canonical, root, remote, lock, serviceFile, auditFile, git, run, runner, audit,
    verificationFile: path.join(canonical, 'verification.jsonl'),
    stateFile: path.join(root, '.git', 'projects-pr-v2', 'rehearsal.json') };
}

export async function createFixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-delivery-')));
  // All worktrees, service data, and Git objects are under this test-owned directory.
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.mkdir(path.join(directory, 'home'));
  await fs.mkdir(path.join(directory, 'no-hooks'));
  await writeJson(path.join(directory, 'fixture.json'), { kind: 'local-delivery-rehearsal', directory });
  await writeJson(path.join(directory, 'service.json'), { fault: null, pulls: [] });
  const f = await openFixture(directory);
  await f.git(['init', '--bare', f.remote], directory);
  await fs.mkdir(f.root);
  await f.git(['init', '-b', 'main']);
  await f.git(['remote', 'add', 'origin', f.remote]);
  await fs.writeFile(path.join(f.root, 'proof.txt'), 'base\n');
  await fs.writeFile(path.join(f.root, 'verify.mjs'), `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
fs.appendFileSync(process.env.LOCAL_DELIVERY_VERIFY_LOG, JSON.stringify({ head, cwd: process.cwd() }) + '\\n');
if (fs.readFileSync('proof.txt', 'utf8') !== 'worker\\n') {
  console.error('PRIVATE_FIXTURE_VERIFICATION_OUTPUT'); process.exitCode = 7;
}
`);
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'fixture base']);
  f.base = await f.git(['rev-parse', 'HEAD']);
  await f.git(['push', 'origin', 'main']);
  return f;
}

export async function cli(f, command, extra = []) {
  const args = [command, '--repo', f.root];
  if (command !== 'doctor') args.push('--pack-id', 'rehearsal');
  if (command === 'prepare') args.push('--title', 'Local lifecycle', '--base', 'main', '--verify-command', VERIFY);
  args.push(...extra);
  const result = await f.run({ executable: 'node', args: [DRIVER, f.directory, ...args],
    cwd: f.root, shell: false, timeoutMs: 30_000 });
  assert.ok([0, 1, 2].includes(result.exitCode) && !result.processUncertain, 'CLI fixture exceeded its process bound');
  assert.equal(Boolean(result.stdout.trim()) !== Boolean(result.stderr.trim()), true, 'exactly one receipt stream');
  const receipt = JSON.parse(result.stdout || result.stderr);
  assert.equal(receipt.command, command);
  return { exitCode: result.exitCode, receipt, text: result.stdout + result.stderr };
}
