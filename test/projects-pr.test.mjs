import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PROJECTS_PR_CONSTRAINTS,
  PROJECTS_PR_SCHEMA_VERSION,
  PROJECTS_PR_STATE_SCHEMA_VERSION,
  ProjectsPrError,
  abortProjectsPr,
  createProjectsPrPlan,
  finalizeProjectsPr,
  parseGitHubRemote,
  prepareProjectsPr,
  runProjectsPrDoctor,
  statusProjectsPr
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs';
import { main, parseProjectsPrArgs } from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs';

const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);

class ControllerRunner {
  constructor(repositoryRoot) {
    this.repositoryRoot = repositoryRoot;
    this.calls = [];
    this.baseBranch = 'main';
    this.baseOid = BASE_OID;
    this.remoteBaseOid = BASE_OID;
    this.localBranch = null;
    this.localOid = null;
    this.worktreePath = null;
    this.worktreeRegistered = false;
    this.worktreeClean = true;
    this.remoteOid = null;
    this.remoteReachable = true;
    this.prs = [];
    this.apiPrOverrides = {};
    this.failVerification = false;
    this.failPrCreate = false;
    this.gitAvailable = true;
    this.shellAvailable = true;
    this.ghAvailable = true;
    this.authenticated = true;
    this.repositoryAccessible = true;
    this.pushPermission = true;
    this.dirtyRepository = false;
    this.remoteUrl = 'https://github.com/acme/projects-demo.git';
  }

  async invoke(invocation) {
    this.calls.push(structuredClone(invocation));
    const { executable, args = [], cwd, shell } = invocation;
    if (shell) {
      if (this.failVerification) {
        return { exitCode: 7, stdout: 'SECRET-STDOUT', stderr: 'SECRET-STDERR' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (executable === '/bin/sh') return { exitCode: this.shellAvailable ? 0 : 127, stdout: '', stderr: '' };
    if (executable === 'pwsh') return { exitCode: this.shellAvailable ? 0 : 127, stdout: this.shellAvailable ? '7\n' : '', stderr: '' };
    if (executable === 'gh') return this.#gh(args);
    if (executable !== 'git') return { exitCode: 127, stdout: '', stderr: '' };
    if (!this.gitAvailable) return { exitCode: 127, stdout: '', stderr: '' };
    return this.#git(args, cwd);
  }

  commitWorker() {
    this.localOid = HEAD_OID;
  }

  async #git(args, cwd) {
    const key = args.join(' ');
    if (key === '--version') return { exitCode: 0, stdout: 'git version 2.50.0\n', stderr: '' };
    if (key === 'rev-parse --show-toplevel') return { exitCode: 0, stdout: `${this.repositoryRoot}\n`, stderr: '' };
    if (key === 'status --porcelain=v1 --untracked-files=normal') {
      return {
        exitCode: 0,
        stdout: cwd === this.repositoryRoot && this.dirtyRepository ? ' M dirty.txt\n' : (this.worktreeClean ? '' : ' M changed.txt\n'),
        stderr: ''
      };
    }
    if (key === 'branch --show-current') return { exitCode: 0, stdout: `${this.baseBranch}\n`, stderr: '' };
    if (key === `rev-parse --verify refs/heads/${this.baseBranch}`) return { exitCode: 0, stdout: `${this.baseOid}\n`, stderr: '' };
    if (key === 'rev-parse --git-common-dir') return { exitCode: 0, stdout: '.git\n', stderr: '' };
    if (key === 'remote get-url origin') {
      return { exitCode: 0, stdout: `${this.remoteUrl}\n`, stderr: '' };
    }
    if (key === `ls-remote --heads origin refs/heads/${this.baseBranch}`) {
      return this.remoteReachable
        ? { exitCode: 0, stdout: `${this.remoteBaseOid}\trefs/heads/${this.baseBranch}\n`, stderr: '' }
        : { exitCode: 2, stdout: '', stderr: '' };
    }
    if (args[0] === 'ls-remote' && args[1] === '--heads' && args[2] === 'origin') {
      return this.remoteReachable
        ? {
            exitCode: 0,
            stdout: this.remoteOid ? `${this.remoteOid}\t${args[3]}\n` : '',
            stderr: ''
          }
        : { exitCode: 2, stdout: '', stderr: '' };
    }
    if (args[0] === 'for-each-ref' && args[1] === '--format=%(objectname)') {
      return this.localOid
        ? { exitCode: 0, stdout: `${this.localOid}\n`, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key === 'worktree list --porcelain') {
      const extra = this.worktreeRegistered ? `\nworktree ${this.worktreePath}\nHEAD ${this.localOid}\nbranch refs/heads/${this.localBranch}\n` : '';
      return { exitCode: 0, stdout: `worktree ${this.repositoryRoot}\nHEAD ${this.baseOid}\nbranch refs/heads/main\n${extra}`, stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      this.localBranch = args[3];
      this.worktreePath = args[4];
      this.localOid = args[5];
      this.worktreeRegistered = true;
      await fs.mkdir(this.worktreePath, { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      assert.equal(path.resolve(args[2]), path.resolve(this.worktreePath));
      this.worktreeRegistered = false;
      await fs.rm(this.worktreePath, { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key === `rev-parse refs/heads/${this.baseBranch}`) return { exitCode: 0, stdout: `${this.baseOid}\n`, stderr: '' };
    if (key === 'rev-parse HEAD') return { exitCode: 0, stdout: `${this.localOid}\n`, stderr: '' };
    if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-list' && args[1] === '--count') {
      return { exitCode: 0, stdout: this.localOid === this.baseOid ? '0\n' : '1\n', stderr: '' };
    }
    if (args[0] === 'push') {
      assert.deepEqual(args, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${this.localBranch}`]);
      this.remoteOid = this.localOid;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'branch' && args[1] === '-d') {
      assert.equal(args[2], this.localBranch);
      this.localBranch = null;
      this.localOid = null;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  #gh(args) {
    if (!this.ghAvailable) return { exitCode: 127, stdout: '', stderr: '' };
    if (args[0] === '--version') return { exitCode: 0, stdout: 'gh version 2.80.0\n', stderr: '' };
    if (args[0] === 'auth') return { exitCode: this.authenticated ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'api') {
      if (!this.repositoryAccessible) return { exitCode: 1, stdout: '', stderr: '' };
      const pullMatch = args[3]?.match(/^repos\/acme\/projects-demo\/pulls\/(\d+)$/u);
      if (!pullMatch) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ fullName: 'acme/projects-demo', push: this.pushPermission }),
          stderr: ''
        };
      }
      const number = Number(pullMatch[1]);
      const pr = this.prs.find((item) => item.number === number);
      if (!pr) return { exitCode: 1, stdout: '', stderr: '' };
      const override = this.apiPrOverrides;
      const value = (field, fallback) => Object.hasOwn(override, field) ? override[field] : fallback;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: value('number', pr.number),
          html_url: value('url', pr.url),
          draft: value('draft', pr.isDraft),
          state: value('state', pr.state.toLowerCase()),
          base: {
            ref: value('baseRef', pr.baseRefName),
            repo: { full_name: value('baseRepository', 'acme/projects-demo') }
          },
          head: {
            ref: value('headRef', pr.headRefName),
            sha: value('headOid', pr.headRefOid),
            repo: { full_name: value('headRepository', 'acme/projects-demo') }
          }
        }),
        stderr: ''
      };
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      return { exitCode: 0, stdout: JSON.stringify(this.prs), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      assert.ok(args.includes('--repo'));
      assert.ok(args.includes('github.com/acme/projects-demo'));
      assert.ok(args.includes('--draft'));
      assert.equal(args.includes('--merge'), false);
      assert.equal(args.includes('--ready'), false);
      if (this.failPrCreate) return { exitCode: 1, stdout: '', stderr: 'SECRET GH FAILURE' };
      const head = args[args.indexOf('--head') + 1];
      const base = args[args.indexOf('--base') + 1];
      const pr = {
        number: 42,
        url: 'https://github.com/acme/projects-demo/pull/42',
        isDraft: true,
        state: 'OPEN',
        baseRefName: base,
        headRefName: head,
        headRefOid: this.localOid
      };
      this.prs = [pr];
      return { exitCode: 0, stdout: `${pr.url}\n`, stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: '' };
  }
}

async function fixture(t) {
  const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-pr-v2-'));
  await fs.mkdir(path.join(repositoryRoot, '.git'));
  const runner = new ControllerRunner(repositoryRoot);
  const input = {
    repositoryRoot,
    packId: 'task-controller-v2',
    title: 'Ship controller v2',
    baseBranch: 'main',
    remote: 'origin',
    verificationCommand: 'node --test focused.test.mjs'
  };
  const ownedWorktree = createProjectsPrPlan(input).worktreePath;
  t.after(async () => {
    await fs.rm(repositoryRoot, { recursive: true, force: true });
    await fs.rm(ownedWorktree, { recursive: true, force: true });
  });
  const dependencies = { runner: runner.invoke.bind(runner), nodeVersion: '22.0.0' };
  return { repositoryRoot, runner, input, dependencies };
}

test('doctor is fully read-only, pack-free, exact-repo-bound, and reports explicit capability checks', async (t) => {
  const subject = await fixture(t);
  const receipt = await runProjectsPrDoctor({
    repositoryRoot: subject.repositoryRoot,
    baseBranch: 'main',
    remote: 'origin'
  }, subject.dependencies);
  assert.equal(receipt.schemaVersion, PROJECTS_PR_SCHEMA_VERSION);
  assert.equal(receipt.status, 'ready', JSON.stringify(receipt, null, 2));
  assert.equal(receipt.capability.available, true);
  assert.deepEqual(receipt.repository.github, { host: 'github.com', nameWithOwner: 'acme/projects-demo' });
  assert.equal(receipt.capability.checks.every((item) => item.passed && item.exitCode === 0), true);
  assert.deepEqual(receipt.capability.checks.find((item) => item.id === 'remote_base_oid'), {
    id: 'remote_base_oid', passed: true, code: 'ok', exitCode: 0, detail: null
  });
  assert.equal(subject.runner.calls.some((call) => (
    call.executable === 'git' && ['worktree', 'push'].includes(call.args?.[0])
  ) || (
    call.executable === 'gh' && call.args?.[0] === 'pr' && ['create', 'edit', 'merge'].includes(call.args?.[1])
  )), false);
});

test('doctor rejects a mismatched remote base OID with one bounded check and no mutation', async (t) => {
  const subject = await fixture(t);
  subject.runner.remoteBaseOid = 'c'.repeat(40);
  const receipt = await runProjectsPrDoctor({
    repositoryRoot: subject.repositoryRoot,
    baseBranch: 'main',
    remote: 'origin'
  }, subject.dependencies);
  const remoteBaseCheck = receipt.capability.checks.find((item) => item.id === 'remote_base_oid');
  assert.equal(receipt.status, 'unavailable');
  assert.equal(receipt.capability.available, false);
  assert.deepEqual(remoteBaseCheck, {
    id: 'remote_base_oid',
    passed: false,
    code: 'remote_base_mismatch',
    exitCode: 0,
    detail: `local=${BASE_OID}; remote=${subject.runner.remoteBaseOid}`
  });
  assert.equal(remoteBaseCheck.detail.length <= 160, true);
  assert.equal(subject.runner.calls.some((call) => (
    call.executable === 'git' && ['worktree', 'push'].includes(call.args?.[0])
  ) || (
    call.executable === 'gh' && call.args?.[0] === 'pr' && ['create', 'edit', 'merge'].includes(call.args?.[1])
  )), false);
  assert.equal(subject.runner.localBranch, null);
  assert.equal(subject.runner.worktreeRegistered, false);
  assert.equal(subject.runner.remoteOid, null);
  assert.deepEqual(subject.runner.prs, []);
});

test('doctor returns unavailable without mutation when prerequisites fail', async (t) => {
  const subject = await fixture(t);
  subject.runner.ghAvailable = false;
  const receipt = await runProjectsPrDoctor({ repositoryRoot: subject.repositoryRoot }, {
    ...subject.dependencies,
    nodeVersion: '21.9.0'
  });
  assert.equal(receipt.status, 'unavailable');
  assert.equal(receipt.capability.available, false);
  assert.equal(receipt.capability.checks.find((item) => item.id === 'node').code, 'node_22_required');
  assert.equal(receipt.capability.checks.find((item) => item.id === 'github_cli').code, 'github_cli_unavailable');
});

test('doctor identifies missing Git/shell/auth/access and non-GitHub remotes before mutation', async (t) => {
  const cases = [
    { mutate: (runner) => { runner.gitAvailable = false; }, checkId: 'git', code: 'git_unavailable' },
    {
      mutate: (runner) => { runner.shellAvailable = false; },
      checkId: 'shell',
      code: process.platform === 'win32' ? 'powershell_7_required' : 'shell_unavailable'
    },
    { mutate: (runner) => { runner.authenticated = false; }, checkId: 'github_auth', code: 'github_auth_unavailable' },
    { mutate: (runner) => { runner.repositoryAccessible = false; }, checkId: 'github_repository', code: 'github_repository_unavailable' },
    { mutate: (runner) => { runner.pushPermission = false; }, checkId: 'github_repository', code: 'github_push_unavailable' },
    { mutate: (runner) => { runner.remoteUrl = 'C:/not-github/repo'; }, checkId: 'github_remote', code: 'non_github_remote' }
  ];
  for (const item of cases) {
    const subject = await fixture(t);
    item.mutate(subject.runner);
    const receipt = await runProjectsPrDoctor({ repositoryRoot: subject.repositoryRoot }, subject.dependencies);
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.capability.checks.find((entry) => entry.id === item.checkId)?.code, item.code);
    assert.equal(subject.runner.calls.some((call) => call.args?.[0] === 'push' || call.args?.[1] === 'create'), false);
  }
});

test('GitHub remotes accept credential-free HTTPS/SSH and reject ambiguous, credential-bearing, query, or fragment URLs', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/acme/project.git'), {
    host: 'github.com', nameWithOwner: 'acme/project', repositorySpecifier: 'github.com/acme/project'
  });
  assert.equal(parseGitHubRemote('git@github.example:team/repo.git').repositorySpecifier, 'github.example/team/repo');
  for (const remote of [
    '../repo',
    'https://token@github.com/acme/repo.git',
    'https://git@github.com/acme/repo.git',
    'https://github.com/acme/nested/repo.git',
    'https://github.com/acme/repo.git?access_token=secret',
    'https://github.com/acme/repo.git#token'
  ]) {
    assert.throws(() => parseGitHubRemote(remote), (error) => error instanceof ProjectsPrError && error.code === 'non_github_remote');
  }
});

test('prepare creates resumable state and exposes the exact side-chat worktree path', async (t) => {
  const subject = await fixture(t);
  const receipt = await prepareProjectsPr(subject.input, subject.dependencies);
  const plan = createProjectsPrPlan(subject.input);
  assert.equal(receipt.status, 'prepared');
  assert.equal(receipt.plan.worktreePath, plan.worktreePath);
  assert.equal(receipt.plan.branch, plan.branch);
  assert.equal(receipt.plan.verificationCommand, undefined);
  assert.equal(receipt.state.schemaVersion, PROJECTS_PR_STATE_SCHEMA_VERSION);
  assert.equal(receipt.state.phase, 'prepared');
  assert.equal(receipt.state.path, path.join(subject.repositoryRoot, '.git', 'projects-pr-v2', `${subject.input.packId}.json`));
  const stored = JSON.parse(await fs.readFile(receipt.state.path, 'utf8'));
  assert.equal(stored.phase, 'prepared');
  assert.equal(stored.verificationCommand, subject.input.verificationCommand);
  assert.equal(await fs.stat(plan.worktreePath).then(() => true), true);
  await assert.rejects(prepareProjectsPr(subject.input, subject.dependencies), (error) => {
    assert.equal(error.code, 'state_exists');
    assert.equal(error.receipt.status, 'failed');
    assert.equal(error.receipt.recovery.nextCommand, 'status');
    return true;
  });
});

test('status is read-only and reports local, worktree, remote, and PR observations', async (t) => {
  const subject = await fixture(t);
  await prepareProjectsPr(subject.input, subject.dependencies);
  subject.runner.calls.length = 0;
  const receipt = await statusProjectsPr({
    repositoryRoot: subject.repositoryRoot,
    packId: subject.input.packId
  }, subject.dependencies);
  assert.equal(receipt.status, 'observed');
  assert.equal(receipt.result.observed.localBranch.exists, true);
  assert.equal(receipt.result.observed.worktree.registered, true);
  assert.equal(receipt.result.observed.remoteBranch.exists, false);
  assert.equal(receipt.result.observed.pullRequestCount, 0);
  assert.equal(subject.runner.calls.some((call) => call.args?.[0] === 'push' || call.args?.[1] === 'create'), false);
});

test('finalize verifies, pushes only the exact derived ref, creates and verifies a draft, and cleans exact worktree', async (t) => {
  const subject = await fixture(t);
  const prepared = await prepareProjectsPr(subject.input, subject.dependencies);
  subject.runner.commitWorker();
  const receipt = await finalizeProjectsPr({
    repositoryRoot: subject.repositoryRoot,
    packId: subject.input.packId
  }, subject.dependencies);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.result.resumed, false);
  assert.equal(receipt.result.verification.passed, true);
  assert.equal(receipt.result.verification.exitCode, 0);
  assert.equal(receipt.result.verification.commandSha256, prepared.plan.verificationCommandSha256);
  assert.equal(receipt.result.pushedRefspec, `HEAD:refs/heads/${prepared.plan.branch}`);
  assert.equal(receipt.result.draftPullRequest.draft, true);
  assert.equal(receipt.result.ownerDecision.merge.ownerControlled, true);
  assert.equal(receipt.result.ownerDecision.merge.autoMerge, false);
  assert.equal(receipt.result.cleanup.worktreeRemoved, true);
  assert.equal(subject.runner.worktreeRegistered, false);
  assert.equal(subject.runner.localOid, HEAD_OID);
  const pushes = subject.runner.calls.filter((call) => call.args?.[0] === 'push');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].args, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${prepared.plan.branch}`]);
  assert.equal(subject.runner.calls.some((call) => (
    call.executable === 'gh'
    && call.args?.[0] === 'api'
    && call.args?.[3] === 'repos/acme/projects-demo/pulls/42'
  )), true);
  assert.equal(subject.runner.calls.some((call) => call.executable === 'gh' && call.args?.[1] === 'view'), false);
});

test('finalize resumes after an exact push and excludes command output from a failure receipt', async (t) => {
  const subject = await fixture(t);
  await prepareProjectsPr(subject.input, subject.dependencies);
  subject.runner.commitWorker();
  subject.runner.failPrCreate = true;
  await assert.rejects(
    finalizeProjectsPr({ repositoryRoot: subject.repositoryRoot, packId: subject.input.packId }, subject.dependencies),
    (error) => {
      assert.equal(error.receipt.status, 'failed');
      assert.equal(error.receipt.state.phase, 'pushed');
      assert.equal(error.receipt.recovery.nextCommand, 'finalize');
      const serialized = JSON.stringify(error.receipt);
      assert.doesNotMatch(serialized, /SECRET GH FAILURE/u);
      return true;
    }
  );
  const firstPushCount = subject.runner.calls.filter((call) => call.args?.[0] === 'push').length;
  subject.runner.failPrCreate = false;
  const resumed = await finalizeProjectsPr({
    repositoryRoot: subject.repositoryRoot,
    packId: subject.input.packId
  }, subject.dependencies);
  assert.equal(resumed.status, 'completed');
  assert.equal(subject.runner.calls.filter((call) => call.args?.[0] === 'push').length, firstPushCount);
});

test('finalize completes an interrupted post-cleanup state from the exact verified draft', async (t) => {
  const subject = await fixture(t);
  const prepared = await prepareProjectsPr(subject.input, subject.dependencies);
  subject.runner.commitWorker();
  subject.runner.remoteOid = HEAD_OID;
  const draftPullRequest = {
    number: 43,
    url: 'https://github.com/acme/projects-demo/pull/43',
    draft: true,
    state: 'OPEN',
    base: 'main',
    head: prepared.plan.branch,
    headOid: HEAD_OID
  };
  subject.runner.prs = [{
    number: 43,
    url: draftPullRequest.url,
    isDraft: true,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: prepared.plan.branch,
    headRefOid: HEAD_OID
  }];
  const state = JSON.parse(await fs.readFile(prepared.state.path, 'utf8'));
  await fs.writeFile(prepared.state.path, `${JSON.stringify({
    ...state,
    phase: 'pr_created',
    verifiedCommit: HEAD_OID,
    pushedCommit: HEAD_OID,
    draftPullRequest
  }, null, 2)}\n`);
  subject.runner.worktreeRegistered = false;
  await fs.rm(prepared.plan.worktreePath, { recursive: true });
  const receipt = await finalizeProjectsPr({
    repositoryRoot: subject.repositoryRoot,
    packId: subject.input.packId
  }, subject.dependencies);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.result.resumed, true);
  assert.equal(receipt.result.verification.reused, true);
  assert.equal(receipt.result.draftPullRequest.number, 43);
  assert.equal(subject.runner.calls.filter((call) => call.args?.[0] === 'push').length, 0);
});

test('verification failure records only its exit status and preserves the diagnostic worktree', async (t) => {
  const subject = await fixture(t);
  await prepareProjectsPr(subject.input, subject.dependencies);
  subject.runner.commitWorker();
  subject.runner.failVerification = true;
  await assert.rejects(
    finalizeProjectsPr({ repositoryRoot: subject.repositoryRoot, packId: subject.input.packId }, subject.dependencies),
    (error) => {
      assert.equal(error.code, 'verification_failed');
      assert.equal(error.receipt.error.exitCode, 7);
      assert.equal(error.receipt.result.verification.exitCode, 7);
      assert.equal(error.receipt.result.cleanup.preservedForDiagnosis, true);
      assert.equal(error.receipt.recovery.nextCommand, 'status');
      assert.doesNotMatch(JSON.stringify(error.receipt), /SECRET-STDOUT|SECRET-STDERR/u);
      return true;
    }
  );
  assert.equal(subject.runner.worktreeRegistered, true);
  assert.equal(subject.runner.remoteOid, null);
  assert.equal(subject.runner.prs.length, 0);
});

test('finalize rejects state whose GitHub identity no longer matches the declared remote', async (t) => {
  const subject = await fixture(t);
  const prepared = await prepareProjectsPr(subject.input, subject.dependencies);
  subject.runner.commitWorker();
  const state = JSON.parse(await fs.readFile(prepared.state.path, 'utf8'));
  state.github = {
    host: 'github.com',
    nameWithOwner: 'attacker/other-repo',
    repositorySpecifier: 'github.com/attacker/other-repo'
  };
  await fs.writeFile(prepared.state.path, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(
    finalizeProjectsPr({ repositoryRoot: subject.repositoryRoot, packId: subject.input.packId }, subject.dependencies),
    (error) => {
      assert.equal(error.code, 'repository_binding_mismatch');
      assert.equal(error.receipt.status, 'failed');
      assert.equal(error.receipt.recovery.nextCommand, 'status');
      return true;
    }
  );
  assert.equal(subject.runner.calls.some((call) => call.args?.[0] === 'push'), false);
  assert.equal(subject.runner.calls.some((call) => call.executable === 'gh' && call.args?.[1] === 'create'), false);
});

test('finalize accepts one pre-existing exact draft but refuses mismatched remote state', async (t) => {
  const exact = await fixture(t);
  const prepared = await prepareProjectsPr(exact.input, exact.dependencies);
  exact.runner.commitWorker();
  exact.runner.remoteOid = HEAD_OID;
  exact.runner.prs = [{
    number: 41,
    url: 'https://github.com/acme/projects-demo/pull/41',
    isDraft: true,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: prepared.plan.branch,
    headRefOid: HEAD_OID
  }];
  const receipt = await finalizeProjectsPr({ repositoryRoot: exact.repositoryRoot, packId: exact.input.packId }, exact.dependencies);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.result.draftPullRequest.number, 41);
  assert.equal(exact.runner.calls.filter((call) => call.args?.[0] === 'push').length, 0);
  assert.equal(exact.runner.calls.filter((call) => call.executable === 'gh' && call.args?.[1] === 'create').length, 0);
  assert.equal(exact.runner.calls.some((call) => (
    call.executable === 'gh'
    && call.args?.[0] === 'api'
    && call.args?.[3] === 'repos/acme/projects-demo/pulls/41'
  )), true);

  const mismatch = await fixture(t);
  await prepareProjectsPr(mismatch.input, mismatch.dependencies);
  mismatch.runner.commitWorker();
  mismatch.runner.remoteOid = 'c'.repeat(40);
  await assert.rejects(
    finalizeProjectsPr({ repositoryRoot: mismatch.repositoryRoot, packId: mismatch.input.packId }, mismatch.dependencies),
    (error) => error.code === 'remote_branch_mismatch'
  );

  const nonDraft = await fixture(t);
  const nonDraftPrepared = await prepareProjectsPr(nonDraft.input, nonDraft.dependencies);
  nonDraft.runner.commitWorker();
  nonDraft.runner.remoteOid = HEAD_OID;
  nonDraft.runner.prs = [{
    number: 44,
    url: 'https://github.com/acme/projects-demo/pull/44',
    isDraft: false,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: nonDraftPrepared.plan.branch,
    headRefOid: HEAD_OID
  }];
  await assert.rejects(
    finalizeProjectsPr({ repositoryRoot: nonDraft.repositoryRoot, packId: nonDraft.input.packId }, nonDraft.dependencies),
    (error) => error.code === 'pull_request_mismatch'
  );
});

test('finalize rejects missing or mismatched head OIDs and independently rejects repository mismatches', async (t) => {
  for (const [label, overrides] of [
    ['missing OID', { headOid: null }],
    ['mismatched OID', { headOid: 'c'.repeat(40) }],
    ['preexisting PR repository mismatch', { baseRepository: 'attacker/other-repo' }]
  ]) {
    const subject = await fixture(t);
    const prepared = await prepareProjectsPr(subject.input, subject.dependencies);
    subject.runner.commitWorker();
    subject.runner.remoteOid = HEAD_OID;
    subject.runner.prs = [{
      number: 45,
      url: 'https://github.com/acme/projects-demo/pull/45',
      isDraft: true,
      state: 'OPEN',
      baseRefName: 'main',
      headRefName: prepared.plan.branch,
      headRefOid: HEAD_OID
    }];
    subject.runner.apiPrOverrides = overrides;
    await assert.rejects(
      finalizeProjectsPr({ repositoryRoot: subject.repositoryRoot, packId: subject.input.packId }, subject.dependencies),
      (error) => {
        assert.equal(error.code, 'pull_request_mismatch', label);
        assert.equal(error.receipt.result.cleanup.preservedForDiagnosis, true, label);
        return true;
      }
    );
    assert.equal(subject.runner.worktreeRegistered, true, label);
  }

  const created = await fixture(t);
  await prepareProjectsPr(created.input, created.dependencies);
  created.runner.commitWorker();
  created.runner.apiPrOverrides = { headRepository: 'attacker/other-repo' };
  await assert.rejects(
    finalizeProjectsPr({ repositoryRoot: created.repositoryRoot, packId: created.input.packId }, created.dependencies),
    (error) => {
      assert.equal(error.code, 'pull_request_mismatch');
      assert.equal(error.receipt.result.cleanup.preservedForDiagnosis, true);
      return true;
    }
  );
  assert.equal(created.runner.prs.length, 1);
  assert.equal(created.runner.worktreeRegistered, true);
});

test('abort removes only an unchanged, unpushed preparation and refuses worker commits', async (t) => {
  const clean = await fixture(t);
  await prepareProjectsPr(clean.input, clean.dependencies);
  const receipt = await abortProjectsPr({ repositoryRoot: clean.repositoryRoot, packId: clean.input.packId }, clean.dependencies);
  assert.equal(receipt.status, 'aborted');
  assert.deepEqual(receipt.result.cleanup, { worktreeRemoved: true, localBranchRemoved: true });
  assert.equal(clean.runner.localOid, null);
  assert.equal(clean.runner.worktreeRegistered, false);

  const changed = await fixture(t);
  await prepareProjectsPr(changed.input, changed.dependencies);
  changed.runner.commitWorker();
  await assert.rejects(
    abortProjectsPr({ repositoryRoot: changed.repositoryRoot, packId: changed.input.packId }, changed.dependencies),
    (error) => {
      assert.equal(error.code, 'abort_refused');
      assert.equal(error.receipt.recovery.nextCommand, 'status');
      return true;
    }
  );
  assert.equal(changed.runner.worktreeRegistered, true);
});

test('draft lifecycle grammar remains exact and rejects legacy merge aliases', async () => {
  assert.equal(parseProjectsPrArgs(['doctor']).command, 'doctor');
  assert.equal(parseProjectsPrArgs(['status', '--pack-id', 'task-one']).packId, 'task-one');
  for (const argv of [
    ['--pack-id', 'task-one'],
    ['prepare', '--pack-id', 'task-one', '--work-command', 'old'],
    ['prepare', '--pack-id', 'task-one', '--execute'],
    ['merge', '--pack-id', 'task-one']
  ]) assert.throws(() => parseProjectsPrArgs(argv), ProjectsPrError);
  const output = [];
  assert.equal(await main(['--help'], { log: (value) => output.push(value), error: assert.fail }), 0);
  assert.match(output.join('\n'), /doctor[\s\S]+prepare[\s\S]+status[\s\S]+finalize[\s\S]+abort/u);
  assert.doesNotMatch(output.join('\n'), /--execute|--work-command/u);
});

test('v2 receipts retain fixed capacity, low energy, and draft-only authority', async (t) => {
  const subject = await fixture(t);
  const prepared = await prepareProjectsPr(subject.input, subject.dependencies);
  assert.deepEqual(prepared.constraints, PROJECTS_PR_CONSTRAINTS);
  assert.deepEqual(prepared.constraints, { energy: 'low', workerCount: 1, draftOnly: true });
  assert.equal(prepared.schemaVersion, 2);
});
