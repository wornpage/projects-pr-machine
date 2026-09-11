import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoundedProcessRunner } from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/bounded-process.mjs';
import {
  CLI_PATH, digest, packageEnvironment, npmArguments, validateManifest, validatePackMetadata,
  verifyTarball, regularBytes, verifyInstalledBytes, installedInventory, assertFailureReceipt
} from './helpers/package-evidence.mjs';

const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && path.isAbsolute(npmCli) && (await fs.stat(npmCli)).isFile(),
  'run this contract through npm so npm_execpath is available');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
validateManifest(manifest);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wornpage-package-contract-'));
let uncertain = false;
try {
  const consumer = path.join(temp, 'consumer');
  const artifacts = path.join(temp, 'artifacts');
  await fs.mkdir(consumer); await fs.mkdir(artifacts);
  await fs.writeFile(path.join(temp, 'user.npmrc'), '');
  await fs.writeFile(path.join(temp, 'global.npmrc'), '');
  await fs.writeFile(path.join(consumer, 'package.json'), '{"name":"contract-consumer","private":true}\n');
  const env = packageEnvironment(temp);
  const installed = path.join(consumer, 'node_modules', '@wornpage', 'projects-pr');
  const launcher = path.join(consumer, 'node_modules', '.bin', 'projects-pr');
  const runner = createBoundedProcessRunner({
    spawnProcess: (executable, args, options) => spawn(
      executable === 'node' ? process.execPath : executable === 'installed-launcher' ? launcher : executable,
      args, { ...options, env })
  });
  async function run(executable, args, cwd, expected = 0) {
    assert.equal(uncertain, false, 'interrupted package session cannot continue');
    const result = await runner({ executable, args, cwd, timeoutMs: 30_000 });
    if (result.processUncertain) {
      uncertain = true;
      throw new Error('Package command interrupted; temporary evidence retained.');
    }
    assert.equal(result.exitCode, expected, `package probe failed (${executable})`);
    return result;
  }
  const npm = async (args, cwd) => run('node', [npmCli, ...npmArguments(args, temp)], cwd);
  const packed = validatePackMetadata((await npm(['pack', '--json', '--pack-destination', artifacts], root)).stdout, manifest);
  assert.deepEqual(await fs.readdir(artifacts), [packed.filename]);
  const tarball = path.join(artifacts, packed.filename);
  const tarballSha256 = verifyTarball(await fs.readFile(tarball), packed);
  const source = new Map();
  for (const item of packed.files) {
    const bytes = await regularBytes(root, item.path);
    assert.equal(bytes.length, item.size, 'pack metadata/source size mismatch');
    source.set(item.path, bytes);
  }
  await npm(['install', '--no-save', '--package-lock=false', '--bin-links=true', tarball], consumer);
  validateManifest(JSON.parse((await regularBytes(installed, 'package.json')).toString('utf8')));
  assert.deepEqual(await installedInventory(installed), [...source.keys()].sort());
  const installedHashes = []; const normalizedShebangs = [];
  for (const [name, bytes] of [...source].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const actual = await regularBytes(installed, name);
    if (verifyInstalledBytes(bytes, actual, name)) normalizedShebangs.push(name);
    installedHashes.push({ path: name, sourceSha256: digest(bytes), installedSha256: digest(actual) });
  }
  const cli = path.join(installed, CLI_PATH);
  const commands = ['doctor', 'prepare', 'status', 'finalize', 'authorize', 'authorize-admin', 'finish', 'stack', 'abort'];
  const mutating = commands.filter(name => !['doctor', 'status'].includes(name));
  const invoke = async (args, expected = 0) => run('node', [cli, ...args], consumer, expected);
  for (const args of [['--help'], ...commands.map(command => [command, '--help'])]) {
    const help = await invoke(args);
    assert.equal(help.stderr, '');
    for (const pattern of [/projects-pr v2/u, /authorize-admin/u, /finish/u]) assert.match(help.stdout, pattern);
  }
  for (const command of commands) {
    assertFailureReceipt(await invoke([command, '--force-unlock'], 1), command, 'invalid_input');
  }
  for (const command of [...mutating, 'status']) {
    assertFailureReceipt(await invoke([command], 1), command, 'invalid_input');
  }
  // Invoke the npm-created launcher, not just the underlying module's path.
  const help = process.platform === 'win32'
    ? await run('cmd.exe', ['/d', '/s', '/c', 'node_modules\\.bin\\projects-pr.cmd --help'], consumer)
    : await run('installed-launcher', ['--help'], consumer);
  assert.match(help.stdout, /projects-pr v2/u);
  const imported = await run('node', ['--input-type=module', '--eval',
    "const m = await import('@wornpage/projects-pr'); const c = await import('@wornpage/projects-pr/cli'); console.log([m.runProjectsPrDoctor,m.prepareProjectsPr,m.statusProjectsPr,m.finalizeProjectsPr,m.abortProjectsPr,m.stackProjectsPr,m.authorizeProjectsPr,m.authorizeAdminProjectsPr,m.finishProjectsPr,c.main,c.parseProjectsPrArgs].map(v=>typeof v).join(','));"
  ], consumer);
  assert.equal(imported.stdout.trim(), Array(11).fill('function').join(','));

  const repository = path.join(temp, 'repository');
  await fs.mkdir(repository);
  await run('git', ['init', '--initial-branch=main', '--template='], repository);
  assert.equal((await run('git', ['remote'], repository)).stdout, '');
  const config = await fs.readFile(path.join(repository, '.git', 'config'));
  const lock = path.join(repository, '.git', 'projects-pr-v2.lock');
  const owner = path.join(lock, 'owner.json');
  const ownerBytes = Buffer.from('test-owned interrupted operation; do not adopt\n');
  await fs.mkdir(lock); await fs.writeFile(owner, ownerBytes);
  const ownerIdentity = await fs.lstat(owner, { bigint: true });
  const lockIdentity = await fs.lstat(lock, { bigint: true });
  async function assertOwnerPreserved() {
    assert.deepEqual(await fs.readFile(owner), ownerBytes);
    assert.deepEqual(await fs.readdir(lock), ['owner.json']);
    for (const [location, original] of [[lock, lockIdentity], [owner, ownerIdentity]]) {
      const current = await fs.lstat(location, { bigint: true });
      assert.equal(current.dev, original.dev); assert.equal(current.ino, original.ino);
    }
  }
  for (const command of mutating) {
    const args = [command, '--repo', repository, '--pack-id', 'installed-probe'];
    if (command === 'stack') args.push('--pack-id', 'second-probe', '--base', 'main');
    if (command === 'prepare') args.push('--title', 'Installed probe', '--base', 'main', '--verify-command', 'exit 0');
    const receipt = assertFailureReceipt(await invoke(args, 1), command, 'lifecycle_locked');
    assert.equal(receipt.operationOutcome, 'not_started');
    await assertOwnerPreserved();
  }
  const apiProbe = `
    import assert from 'node:assert/strict';
    const m = await import('@wornpage/projects-pr');
    const input = { repositoryRoot: process.argv[1], packId: 'installed-probe',
      packIds: ['installed-probe', 'second-probe'], title: 'Installed probe', baseBranch: 'main', verificationCommand: 'exit 0' };
    for (const name of ['prepareProjectsPr','finalizeProjectsPr','abortProjectsPr','stackProjectsPr',
      'authorizeProjectsPr','authorizeAdminProjectsPr','finishProjectsPr']) {
      await assert.rejects(m[name](input), error => error.code === 'lifecycle_locked'
        && error.receipt.operationOutcome === 'not_started');
    }
    console.log('installed public API lock probes passed');
  `;
  assert.equal((await run('node', ['--input-type=module', '--eval', apiProbe, repository], consumer)).stdout.trim(),
    'installed public API lock probes passed');
  await assertOwnerPreserved();
  // Missing state gives status a safe, entirely local read path while the lock exists.
  assertFailureReceipt(await invoke(['status', '--repo', repository, '--pack-id', 'installed-probe'], 1), 'status', 'state_not_found');
  await assertOwnerPreserved();
  // This is removal of our own synthetic fixture, never a production recovery step.
  await fs.unlink(owner); await fs.rmdir(lock);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertFailureReceipt(await invoke(['finalize', '--repo', repository, '--pack-id', 'installed-probe'], 1), 'finalize', 'state_not_found');
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
  }
  assert.deepEqual(await fs.readFile(path.join(repository, '.git', 'config')), config);
  assert.deepEqual(await fs.readdir(repository), ['.git']);
  assert.equal((await run('git', ['branch', '--show-current'], repository)).stdout.trim(), 'main');
  assert.equal((await run('git', ['remote'], repository)).stdout, '');
  await assert.rejects(fs.lstat(path.join(temp, '.projects-pr-worktrees')), { code: 'ENOENT' });
  for (const [name, bytes] of source) assert.deepEqual(await regularBytes(root, name), bytes, 'source changed during contract');
  const sourceCommit = (await run('git', ['rev-parse', 'HEAD'], root)).stdout.trim();
  assert.match(sourceCommit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
  const sourceDirty = Boolean((await run('git', ['status', '--porcelain=v1', '--untracked-files=normal'], root)).stdout.trim());
  console.log(JSON.stringify({ schemaVersion: 1, kind: 'installed-package-evidence',
    name: manifest.name, version: manifest.version, sourceCommit, sourceDirty, node: process.versions.node,
    tarballSha256, integrity: packed.integrity, fileCount: source.size,
    fileEvidenceSha256: digest(JSON.stringify(installedHashes)), normalizedShebangs,
    probes: { help: 10, invalidInput: 17, launcher: 1, imports: 11,
      lockedCli: 7, lockedApi: 7, lockFreeStatus: 1, ordinaryFailureRecovery: 2 }
  }));
} finally {
  if (!uncertain) await fs.rm(temp, { recursive: true, force: true });
  else console.error(`Interrupted package-test directory preserved: ${temp}`);
}
console.log('package contract passed');
