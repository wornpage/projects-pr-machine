import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedRehearsalPolicy, verifyHostedTarget } from './lib/hosted-rehearsal-policy.mjs';
import { isOid } from '../integrations/codex/projects-pack-delegation/contracts/readiness-data.mjs';
import { CLI_PATH, createPackageWorkspace, packageEnvironment, npmArguments, validatePackMetadata,
  verifyTarball, regularBytes, installedInventory, verifyInstalledBytes }
  from '../test/helpers/package-evidence.mjs';
import { createBoundedProcessRunner, createProcessSession }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/bounded-process.mjs';

let workspace; let stateFile;
let evidence = { schemaVersion: 1, kind: 'hosted-draft-rehearsal', status: 'refused', code: 'rehearsal_failed' };
try {
  const source = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
  const policy = hostedRehearsalPolicy(JSON.parse(await fs.readFile(path.join(source, '.github/hosted-rehearsal.json'), 'utf8')),
    process.env.REHEARSAL_CONFIRM_REPOSITORY);
  assert.ok(isOid(process.env.REHEARSAL_EXPECTED_SOURCE), 'exact source revision required');
  assert.ok(typeof process.env.GH_TOKEN === 'string' && process.env.GH_TOKEN.length > 0, 'scoped credential required');
  assert.ok(path.isAbsolute(process.env.npm_execpath ?? ''), 'invoke through npm');
  workspace = await createPackageWorkspace(os.tmpdir());
  const home = path.join(workspace, 'home'); await fs.mkdir(home);
  for (const file of ['user.npmrc', 'global.npmrc', 'gitconfig']) await fs.writeFile(path.join(home, file), '');
  await fs.mkdir(path.join(home, 'no-hooks'));
  const npmEnv = packageEnvironment(home);
  const hostEnv = { ...npmEnv, GH_TOKEN: process.env.GH_TOKEN, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
    GH_CONFIG_DIR: path.join(home, 'gh'), GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_ALLOW_PROTOCOL: 'https',
    REHEARSAL_TRACE: path.join(workspace, 'verification.jsonl') };
  const config = { 'core.hooksPath': path.join(home, 'no-hooks'), 'core.fsmonitor': 'false',
    'user.name': 'Wornpage rehearsal', 'user.email': 'rehearsal@example.invalid', 'commit.gpgSign': 'false' };
  hostEnv.GIT_CONFIG_COUNT = String(Object.keys(config).length);
  Object.entries(config).forEach(([key, value], i) => {
    hostEnv[`GIT_CONFIG_KEY_${i}`] = key; hostEnv[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  const session = environment => createProcessSession(createBoundedProcessRunner({ spawnProcess: (command, args, options) =>
    spawn(command, args, { ...options, env: environment }) }));
  const npmSession = session(npmEnv); const hostSession = session(hostEnv);
  async function run(owner, executable, args, cwd = source) {
    // Neither session may continue after uncertain termination in either one.
    assert.ok(npmSession.canRelease() && hostSession.canRelease(), 'uncertain rehearsal session');
    const result = await owner.runner({ executable, args, cwd, shell: false, timeoutMs: 30000 });
    assert.equal(result.exitCode, 0, 'rehearsal subprocess refused');
    assert.ok(!result.processUncertain, 'uncertain rehearsal subprocess');
    return result.stdout.trim();
  }
  const host = (executable, args, cwd) => run(hostSession, executable, args, cwd);
  const npm = (args, cwd) => run(npmSession, 'node', [process.env.npm_execpath, ...npmArguments(args, home)], cwd);
  const api = async endpoint => JSON.parse(await host('gh', ['api', '--hostname', 'github.com', endpoint]));
  assert.equal(await host('git', ['rev-parse', 'HEAD']), process.env.REHEARSAL_EXPECTED_SOURCE);
  assert.equal(await host('git', ['status', '--porcelain=v1', '--untracked-files=normal']), '');
  const metadata = await api(`repos/${policy.repository}`);
  const ref = await api(`repos/${policy.repository}/git/ref/heads/main`);
  // Refuse before clone or any remote write. Marker is checked from exact cloned base below.
  verifyHostedTarget(policy, metadata, { kind: 'projects-pr-disposable-rehearsal', repositoryId: policy.repositoryId }, ref.object?.sha);
  await host('gh', ['auth', 'setup-git', '--hostname', 'github.com']);
  const checkout = path.join(workspace, 'checkout');
  await host('git', ['clone', '--no-recurse-submodules', '--single-branch', '--branch', 'main',
    `https://github.com/${policy.repository}.git`, checkout]);
  const baseOid = await host('git', ['rev-parse', 'HEAD'], checkout);
  const marker = JSON.parse(await fs.readFile(path.join(checkout, '.projects-pr-rehearsal.json'), 'utf8'));
  verifyHostedTarget(policy, metadata, marker, baseOid);

  const artifactDirectory = path.join(workspace, 'artifact'); await fs.mkdir(artifactDirectory);
  const manifest = JSON.parse(await regularBytes(source, 'package.json'));
  const record = validatePackMetadata(await npm(['pack', '--json', '--pack-destination', artifactDirectory], source), manifest);
  const tarball = path.join(artifactDirectory, record.filename);
  const artifactSha256 = verifyTarball(await fs.readFile(tarball), record);
  const consumer = path.join(workspace, 'consumer'); await fs.mkdir(consumer);
  await npm(['install', '--prefix', consumer, '--no-package-lock', '--no-save', tarball], source);
  const installed = path.join(consumer, 'node_modules', '@wornpage', 'projects-pr');
  assert.deepEqual(await installedInventory(installed), record.files.map(file => file.path).sort());
  for (const file of record.files) verifyInstalledBytes(await regularBytes(source, file.path),
    await regularBytes(installed, file.path), file.path);
  const packId = `rehearsal-${randomBytes(12).toString('hex')}`;
  const filename = `${packId}.mjs`;
  stateFile = path.join(checkout, '.git', 'projects-pr-v2', `${packId}.json`);
  const invoke = async (command, args = []) => JSON.parse(await host('node', [path.join(installed, CLI_PATH), command,
    '--repo', checkout, ...(command === 'doctor' ? [] : ['--pack-id', packId]), ...args], checkout));
  assert.equal((await invoke('doctor', ['--base', 'main'])).status, 'ready');
  const prepared = await invoke('prepare', ['--base', 'main', '--title', 'Hosted rehearsal', '--verify-command', `node ${filename}`]);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state.path, stateFile);
  const worktree = prepared.plan.worktreePath; const branch = prepared.plan.branch;
  assert.equal(path.dirname(worktree), path.join(workspace, '.projects-pr-worktrees'));
  assert.ok(branch.startsWith(`projects-pr/${packId}-`));
  await fs.writeFile(path.join(worktree, filename), `import fs from 'node:fs';\nimport { execFileSync } from 'node:child_process';\nconst head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();\nfs.appendFileSync(process.env.REHEARSAL_TRACE, JSON.stringify({head}) + '\\n');\n`, { flag: 'wx' });
  await host('git', ['add', '--', filename], worktree);
  await host('git', ['commit', '-m', 'Disposable installed-client rehearsal'], worktree);
  const headOid = await host('git', ['rev-parse', 'HEAD'], worktree);
  assert.ok(isOid(headOid));
  const finalized = await invoke('finalize');
  assert.equal(finalized.status, 'completed');
  assert.equal(finalized.result.draftPullRequest.headOid, headOid);
  assert.equal(finalized.result.ownerDecision.merge.status, 'not_requested');
  const number = finalized.result.draftPullRequest.number;
  const observed = await api(`repos/${policy.repository}/pulls/${number}`);
  assert.equal(observed.draft, true); assert.equal(observed.merged, false); assert.equal(observed.state, 'open');
  assert.equal(observed.head.sha, headOid); assert.equal(observed.base.sha, baseOid);
  assert.equal((await invoke('status')).result.observed.pullRequestCount, 1);
  assert.equal((await invoke('finalize')).result.resumed, true);
  assert.equal((await invoke('status')).result.observed.pullRequestCount, 1);
  const trace = (await fs.readFile(hostEnv.REHEARSAL_TRACE, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace, [{ head: headOid }]);
  assert.equal((await api(`repos/${policy.repository}/git/ref/heads/main`)).object.sha, baseOid);
  evidence = { schemaVersion: 1, kind: 'hosted-draft-rehearsal', status: 'verified',
    repository: policy.repository, repositoryId: policy.repositoryId, baseOid, headOid, number,
    sourceCommit: process.env.REHEARSAL_EXPECTED_SOURCE, artifactSha256, draftPreserved: true,
    repeatedFinalize: true, independentReview: false, mergeRequested: false, workspace };
  // Preserve the owned draft/branch and local evidence for operator inspection.
  // There is intentionally no automatic remote deletion or ambiguous rollback.
} catch (error) {
  evidence = { schemaVersion: 1, kind: 'hosted-draft-rehearsal', status: 'refused',
    code: error?.name === 'ReadinessError' ? error.code : 'rehearsal_failed',
    ...(workspace ? { workspace, reconcileBeforeRetry: true } : {}) };
  process.exitCode = 1;
} finally {
  // Only explicitly selected JSON fields are retained. Never upload HOME, tokens,
  // raw subprocess output, a .git directory, or the npm consumer.
  const directory = process.env.REHEARSAL_EVIDENCE_DIRECTORY;
  if (directory) {
    try {
      assert.ok(path.isAbsolute(directory));
      await fs.mkdir(directory);
      if (stateFile) {
        try {
          const stat = await fs.lstat(stateFile); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 262144);
          const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
          const keys = ['schemaVersion', 'kind', 'phase', 'packId', 'repositoryRoot', 'worktreePath',
            'branch', 'baseBranch', 'remote', 'baseCommit', 'verifiedCommit', 'pushedCommit', 'verificationCommandSha256'];
          const snapshot = Object.fromEntries(keys.filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]]));
          await fs.writeFile(path.join(directory, 'state-summary.json'), JSON.stringify(snapshot), { flag: 'wx' });
        } catch { evidence.stateEvidenceUnavailable = true; }
      }
      await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(evidence), { flag: 'wx' });
    } catch {
      evidence = { kind: 'hosted-draft-rehearsal', status: 'refused', code: 'evidence_persistence_failed', workspace };
      process.exitCode = 1;
    }
  }
}
if (process.exitCode === 1) console.error(JSON.stringify(evidence));
else console.log(JSON.stringify(evidence));
