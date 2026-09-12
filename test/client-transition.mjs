import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixtures/local-delivery-harness.mjs';
import { CLI_PATH, createPackageWorkspace, packageEnvironment, npmArguments, regularBytes,
  installedInventory, verifyInstalledBytes, verifyTarball, digest } from './helpers/package-evidence.mjs';
import { RELEASE_BASELINE, transitionPackMetadata, assertTransitionFixtureUnlocked } from './helpers/client-transition.mjs';
import { createBoundedProcessRunner, createProcessSession }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/bounded-process.mjs';

const source = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
const baseline = await fs.realpath(process.argv[2] ?? '');
assert.notEqual(baseline, source, 'separate pinned baseline checkout required');
const npmCli = process.env.npm_execpath;
assert.ok(typeof npmCli === 'string' && path.isAbsolute(npmCli), 'invoke through npm run check:transition');
const workspace = await createPackageWorkspace(os.tmpdir());
const cleanups = []; let f; let safe = true;
const home = path.join(workspace, 'home'); await fs.mkdir(home);
for (const file of ['user.npmrc', 'global.npmrc']) await fs.writeFile(path.join(home, file), '');
const env = packageEnvironment(home);
const session = createProcessSession(createBoundedProcessRunner({ spawnProcess: (command, args, options) =>
  spawn(command, args, { ...options, env }) }));
async function run(executable, args, cwd = source, expected = 0) {
  const result = await session.runner({ executable, args, cwd, shell: false, timeoutMs: 30000 });
  if (!session.canRelease()) safe = false;
  assert.equal(result.exitCode, expected, 'transition subprocess failed');
  assert.equal(result.processUncertain, undefined, 'transition subprocess uncertain');
  return result;
}
const npm = (args, cwd) => run('node', [npmCli, ...npmArguments(args, home)], cwd);
const git = async (args, cwd) => (await run('git', args, cwd)).stdout.trim();
try {
  assert.equal(await git(['rev-parse', 'HEAD'], baseline), RELEASE_BASELINE, 'pinned released-source baseline');
  for (const root of [source, baseline]) assert.equal(await git(['status', '--porcelain=v1', '--untracked-files=normal'], root), '');
  const sourceCommit = await git(['rev-parse', 'HEAD'], source);
  async function pack(root, label) {
    const destination = path.join(workspace, label); await fs.mkdir(destination);
    const manifest = JSON.parse(await regularBytes(root, 'package.json'));
    const record = transitionPackMetadata((await npm(['pack', '--json', '--pack-destination', destination], root)).stdout, manifest);
    const tarball = path.join(destination, record.filename);
    const sha256 = verifyTarball(await fs.readFile(tarball), record);
    const bytes = new Map();
    for (const file of record.files) bytes.set(file.path, await regularBytes(root, file.path));
    return { record, tarball, sha256, bytes };
  }
  const oldArtifact = await pack(baseline, 'baseline');
  const candidate = await pack(source, 'candidate');
  assert.notEqual(candidate.sha256, oldArtifact.sha256, 'different source artifacts required');
  const consumer = path.join(workspace, 'consumer'); await fs.mkdir(consumer);
  const installed = path.join(consumer, 'node_modules', '@wornpage', 'projects-pr');
  const cli = path.join(installed, CLI_PATH);
  async function install(artifact) {
    if (f) await assertTransitionFixtureUnlocked(f.root);
    // Recheck immutable archive bytes before every install, including rollback.
    assert.equal(verifyTarball(await fs.readFile(artifact.tarball), artifact.record), artifact.sha256);
    await npm(['install', '--prefix', consumer, '--no-package-lock', '--no-save', artifact.tarball], source);
    assert.deepEqual(await installedInventory(installed), [...artifact.bytes.keys()].sort());
    const files = [];
    for (const [name, original] of [...artifact.bytes].sort(([a], [b]) => a.localeCompare(b))) {
      const actual = await regularBytes(installed, name);
      const shebangNormalized = verifyInstalledBytes(original, actual, name);
      files.push({ path: name, sourceSha256: digest(original), installedSha256: digest(actual), shebangNormalized });
    }
    const help = await run('node', [cli, '--help'], consumer);
    assert.match(help.stdout, /projects-pr v2/u);
    return { artifactSha256: artifact.sha256, version: artifact.record.version, files: files.length,
      fileEvidenceSha256: digest(JSON.stringify(files)) };
  }
  const stages = [{ stage: 'baseline', ...await install(oldArtifact) }];
  f = await createFixture({ after: callback => cleanups.push(callback) });
  const driver = fileURLToPath(new URL('./fixtures/installed-transition-cli.mjs', import.meta.url));
  async function probe(mode, expected = 0) {
    const result = await f.run({ executable: 'node', args: [driver, f.directory, cli, mode], cwd: f.root,
      shell: false, timeoutMs: 30000 });
    if (result.processUncertain) safe = false;
    assert.equal(result.exitCode, expected, 'installed transition probe failed');
    assert.ok(!result.processUncertain);
    return JSON.parse(expected === 0 ? result.stdout : result.stderr);
  }
  assert.equal((await probe('baseline-prepare')).status, 'prepared');
  const state = await fs.readFile(f.stateFile); const stateSha256 = digest(state);
  const checkState = async () => {
    assert.equal((await probe('status')).status, 'observed');
    assert.deepEqual(await fs.readFile(f.stateFile), state);
  };
  await checkState();
  stages.push({ stage: 'candidate', ...await install(candidate) }); await checkState();
  // An old binary does not understand this lock; refuse to install it rather
  // than testing a dangerous legacy mutation. Never remove a production lock.
  await fs.mkdir(f.lock); await fs.writeFile(path.join(f.lock, 'sentinel'), 'transition-owned');
  await assert.rejects(install(oldArtifact), { code: 'transition_locked' });
  assert.equal((await probe('locked-finalize', 1)).error.code, 'lifecycle_locked');
  assert.equal(await fs.readFile(path.join(f.lock, 'sentinel'), 'utf8'), 'transition-owned');
  await checkState();
  await fs.unlink(path.join(f.lock, 'sentinel')); await fs.rmdir(f.lock);
  stages.push({ stage: 'rollback', ...await install(oldArtifact) }); await checkState();
  assert.equal(stages[0].fileEvidenceSha256, stages[2].fileEvidenceSha256);
  assert.equal((await fs.readdir(f.directory)).includes('verification.jsonl'), false, 'no verification was run');
  for (const root of [source, baseline]) assert.equal(await git(['status', '--porcelain=v1', '--untracked-files=normal'], root), '');
  console.log(JSON.stringify({ schemaVersion: 1, kind: 'client-transition-evidence', status: 'verified',
    sourceCommit, baselineCommit: RELEASE_BASELINE, sourceDirty: false, stages, stateSha256,
    preservedLegacyState: true, lockedRollbackRefused: true, hostedGitHub: false, registryPublication: false }));
} catch (error) {
  safe = false;
  console.error(JSON.stringify({ kind: 'client-transition-evidence', status: 'refused',
    message: 'Transition check failed; no installed production client was changed.', workspace }));
  // Test diagnostics contain only isolated fixture data, never inherited tokens.
  console.error(error); process.exitCode = 1;
} finally {
  if (safe && session.canRelease()) {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}
