import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseProjectsPrArgs } from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs';
import {
  PROJECTS_PR_STATE_SCHEMA_VERSION,
  createProjectsPrPlan,
  runProjectsPrDoctor,
  stackProjectsPr
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs';

const BASE_OID = '1'.repeat(40);
const BOTTOM_OID = '2'.repeat(40);
const TOP_OID = '3'.repeat(40);

function invocationKey(invocation) {
  return [invocation.executable, ...(invocation.args ?? [])].join(' ');
}

function createRunner({ repositoryRoot, officialExtension = true } = {}) {
  let linked = false;
  const calls = [];
  const branchData = new Map();
  const runner = async (invocation) => {
    calls.push(invocation);
    const key = invocationKey(invocation);
    const args = invocation.args ?? [];
    if (key === 'git --version') return { exitCode: 0, stdout: 'git version 2.51.0\n' };
    if (invocation.executable === 'pwsh') return { exitCode: 0, stdout: '7\n' };
    if (invocation.executable === '/bin/sh') return { exitCode: 0, stdout: '' };
    if (key === 'git rev-parse --show-toplevel') return { exitCode: 0, stdout: `${repositoryRoot}\n` };
    if (key === 'git status --porcelain=v1 --untracked-files=normal') return { exitCode: 0, stdout: '' };
    if (key === 'git branch --show-current') return { exitCode: 0, stdout: 'main\n' };
    if (key === 'git rev-parse --verify refs/heads/main') return { exitCode: 0, stdout: `${BASE_OID}\n` };
    if (key === 'git rev-parse --git-common-dir') return { exitCode: 0, stdout: '.git\n' };
    if (key === 'git remote get-url origin') return { exitCode: 0, stdout: 'https://github.com/acme/repo.git\n' };
    if (args[0] === 'ls-remote' && args[1] === '--heads') {
      const branch = args[3].replace('refs/heads/', '');
      const oid = branch === 'main' ? BASE_OID : branchData.get(branch)?.oid;
      return { exitCode: 0, stdout: oid ? `${oid}\trefs/heads/${branch}\n` : '' };
    }
    if (key === 'gh --version') return { exitCode: 0, stdout: 'gh version 2.96.0\n' };
    if (key === 'gh auth status --hostname github.com') return { exitCode: 0, stdout: 'authenticated\n' };
    if (args[0] === 'api' && args.includes('repos/acme/repo') && args.includes('--jq')) {
      return { exitCode: 0, stdout: '{"fullName":"acme/repo","push":true}\n' };
    }
    if (key === 'gh extension list') {
      return {
        exitCode: 0,
        stdout: officialExtension ? 'gh stack\tgithub/gh-stack\tv0.1.0\n' : 'gh stack\tthird-party/gh-stack\tv0.1.0\n'
      };
    }
    if (key === 'gh stack --version') return { exitCode: 0, stdout: 'gh stack version 0.1.0\n' };
    if (key === 'gh stack link --help') {
      return { exitCode: 0, stdout: '--base string\n--remote string\n' };
    }
    if (args[0] === 'stack' && args[1] === 'link') {
      linked = true;
      return { exitCode: 0, stdout: 'Linked stack\n' };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const branch = args[2];
      const data = branchData.get(branch);
      const base = linked && data.index > 0 ? [...branchData.keys()][data.index - 1] : 'main';
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          number: data.number,
          url: `https://github.com/acme/repo/pull/${data.number}`,
          isDraft: true,
          state: 'OPEN',
          baseRefName: base,
          headRefName: branch,
          headRefOid: data.oid
        })}\n`
      };
    }
    return { exitCode: 1, stderr: `Unexpected invocation: ${key}` };
  };
  runner.calls = calls;
  runner.branchData = branchData;
  return runner;
}

async function writeCompletedState(repositoryRoot, runner, { packId, title, oid, number, index }) {
  const plan = createProjectsPrPlan({
    repositoryRoot,
    packId,
    title,
    baseBranch: 'main',
    remote: 'origin',
    verificationCommand: 'npm test'
  });
  runner.branchData.set(plan.branch, { oid, number, index });
  const state = {
    schemaVersion: PROJECTS_PR_STATE_SCHEMA_VERSION,
    kind: 'projects-pr-state',
    packId,
    title,
    repositoryRoot,
    baseBranch: 'main',
    baseCommit: BASE_OID,
    remote: 'origin',
    github: {
      host: 'github.com',
      nameWithOwner: 'acme/repo',
      repositorySpecifier: 'github.com/acme/repo'
    },
    branch: plan.branch,
    worktreePath: plan.worktreePath,
    verificationCommand: plan.verificationCommand,
    verificationCommandSha256: plan.verificationCommandSha256,
    phase: 'completed',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    verifiedCommit: oid,
    pushedCommit: oid,
    draftPullRequest: { number, url: `https://github.com/acme/repo/pull/${number}`, draft: true }
  };
  const stateDirectory = path.join(repositoryRoot, '.git', 'projects-pr-v2');
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, `${packId}.json`), `${JSON.stringify(state)}\n`, 'utf8');
  return plan;
}

test('CLI parses stack doctor flag and repeated pack IDs in order', () => {
  assert.deepEqual(parseProjectsPrArgs(['doctor', '--stack', '--base', 'main']), {
    command: 'doctor', stack: true, baseBranch: 'main', repositoryRoot: path.resolve(process.cwd())
  });
  assert.deepEqual(parseProjectsPrArgs([
    'stack', '--pack-id', 'bottom', '--pack-id', 'top', '--base', 'main', '--remote', 'origin'
  ]).packIds, ['bottom', 'top']);
});

test('stack-aware doctor rejects a non-official extension owner', async () => {
  const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-pr-doctor-'));
  const runner = createRunner({ repositoryRoot, officialExtension: false });
  const receipt = await runProjectsPrDoctor({ repositoryRoot, baseBranch: 'main', stack: true }, { runner });
  assert.equal(receipt.status, 'unavailable');
  assert.equal(receipt.capability.stackRequested, true);
  assert.equal(receipt.capability.checks.find((item) => item.id === 'github_stack_extension').passed, false);
});

test('stack links completed drafts bottom-to-top and verifies exact chained bases', async () => {
  const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-pr-stack-'));
  const runner = createRunner({ repositoryRoot });
  const bottom = await writeCompletedState(repositoryRoot, runner, {
    packId: 'pack-bottom', title: 'Bottom layer', oid: BOTTOM_OID, number: 41, index: 0
  });
  const top = await writeCompletedState(repositoryRoot, runner, {
    packId: 'pack-top', title: 'Top layer', oid: TOP_OID, number: 42, index: 1
  });

  const receipt = await stackProjectsPr({
    repositoryRoot,
    baseBranch: 'main',
    remote: 'origin',
    packIds: ['pack-bottom', 'pack-top']
  }, { runner });

  assert.equal(receipt.status, 'completed');
  assert.deepEqual(receipt.layers.map(({ packId, branch, base }) => ({ packId, branch, base })), [
    { packId: 'pack-bottom', branch: bottom.branch, base: 'main' },
    { packId: 'pack-top', branch: top.branch, base: bottom.branch }
  ]);
  assert.equal(receipt.layers.every((layer) => layer.pullRequest.draft === true), true);
  assert.equal(receipt.result.officialExtension, 'github/gh-stack');
  assert.equal(receipt.result.mergeRequested, false);
  assert.equal(runner.calls.some((call) => invocationKey(call) === [
    'gh', 'stack', 'link', '--base', 'main', '--remote', 'origin', bottom.branch, top.branch
  ].join(' ')), true);
});
