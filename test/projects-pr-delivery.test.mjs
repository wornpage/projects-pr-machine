import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authorizeAdminProjectsPr,
  authorizeProjectsPr,
  createProjectsPrPlan,
  finishProjectsPr
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs';
import { parseProjectsPrArgs } from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs';

const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const MERGE_OID = 'c'.repeat(40);
const CHANGED_OID = 'd'.repeat(40);

function policy(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    repository: 'github.com/acme/repo',
    reviewedMerge: {
      enabled: true,
      method: 'squash',
      requiredChecks: [{ kind: 'check-run', name: 'ci', publisherId: 15368 }]
    },
    remoteBranchCleanup: { enabled: true, protectedBranches: [] },
    adminOverride: { enabled: false },
    ...overrides
  });
}

// Lock discovery is local and bounded separately from the delivery effects.
function assertInvocationTimeout(invocation) {
  if (invocation.timeoutMs === undefined) return;
  const lockDiscovery = invocation.executable === 'git'
    && invocation.args?.length === 2 && invocation.args[0] === 'rev-parse'
    && ['--show-toplevel', '--git-common-dir'].includes(invocation.args[1]);
  assert.equal(invocation.timeoutMs, lockDiscovery ? 10_000 : 30_000);
}

class DeliveryRunner {
  constructor() {
    this.calls = [];
    this.policyText = policy();
    this.pr = {
      number: 7,
      html_url: 'https://github.com/acme/repo/pull/7',
      draft: true,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      mergeable: true,
      mergeable_state: 'clean',
      base: { ref: 'main', sha: BASE_OID, repo: { full_name: 'acme/repo' } },
      head: { ref: null, sha: HEAD_OID, repo: { full_name: 'acme/repo' } }
    };
    this.checkRuns = [{
      name: 'ci', app: { id: 15368 }, head_sha: HEAD_OID,
      status: 'completed', conclusion: 'success'
    }];
    this.statuses = [];
    this.remoteOid = HEAD_OID;
    this.pushUrls = ['https://github.com/acme/repo.git'];
    this.remoteMirror = [];
    this.openExtras = [];
    this.rules = [];
    this.branchProtected = false;
    this.viewerPermission = 'ADMIN';
    this.classicRefName = 'main';
    this.classicBranchProtectionRule = null;
    this.failClassicProtectionObservation = false;
    this.classicProtectionExitCode = 0;
    this.failNormalMerge = false;
    this.failCheckObservation = false;
    this.raceDelete = false;
  }

  async invoke(invocation) {
    this.calls.push(structuredClone(invocation));
    assertInvocationTimeout(invocation);
    if (invocation.executable === 'gh' || (invocation.executable === 'git' && invocation.args?.[0] === 'push')) {
      const owner = JSON.parse(await fs.readFile(
        path.join(this.repositoryRoot, '.git', 'projects-pr-v2.lock', 'owner.json'), 'utf8'));
      assert.equal(owner.kind, 'projects-pr-lifecycle-lock');
      assert.equal(owner.pid, process.pid);
    }
    if (invocation.executable === 'git') return this.#git(invocation.args);
    if (invocation.executable === 'gh') return this.#gh(invocation.args);
    throw new Error(`unexpected executable: ${invocation.executable}`);
  }

  #git(args) {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { exitCode: 0, stdout: `${this.repositoryRoot}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      return { exitCode: 0, stdout: '.git\n', stderr: '' };
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { exitCode: 0, stdout: `${this.pushUrls.join('\n')}\n`, stderr: '' };
    }
    if (args[0] === 'config' && args[1] === '--get-all') {
      return {
        exitCode: this.remoteMirror.length ? 0 : 1,
        stdout: this.remoteMirror.length ? `${this.remoteMirror.join('\n')}\n` : '',
        stderr: ''
      };
    }
    if (args[0] === 'ls-remote') {
      return {
        exitCode: 0,
        stdout: this.remoteOid ? `${this.remoteOid}\t${args[3]}\n` : '',
        stderr: ''
      };
    }
    if (args[0] === 'push') {
      if (this.raceDelete) {
        this.remoteOid = CHANGED_OID;
        return { exitCode: 1, stdout: '', stderr: 'lease rejected' };
      }
      const expectedLease = `--force-with-lease=refs/heads/${this.pr.head.ref}:${HEAD_OID}`;
      assert.deepEqual(args, ['push', expectedLease, 'origin', `:refs/heads/${this.pr.head.ref}`]);
      this.remoteOid = null;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected git invocation: ${args.join(' ')}`);
  }

  #openPulls() {
    const current = this.pr.state === 'open' && !this.pr.merged ? [this.pr] : [];
    return [...current, ...this.openExtras];
  }

  #gh(args) {
    if (args[0] === 'pr' && args[1] === 'ready') {
      assert.deepEqual(args.slice(0, 4), ['pr', 'ready', '7', '--repo']);
      this.pr.draft = false;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      assert.equal(args.includes('--admin'), true);
      assert.equal(args.includes('--match-head-commit'), true);
      assert.equal(args.includes('--auto'), false);
      this.#merge();
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] !== 'api') throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    if (args[1] === 'graphql') {
      const query = args.find((argument) => argument.startsWith('query='));
      if (query?.includes('branchProtectionRule')) {
        return {
          exitCode: this.classicProtectionExitCode,
          stdout: JSON.stringify(this.failClassicProtectionObservation
            ? { errors: [{ message: 'forbidden' }], data: { repository: null } }
            : {
                data: {
                  repository: {
                    viewerPermission: this.viewerPermission,
                    ref: this.classicRefName === null ? null : {
                      name: this.classicRefName,
                      branchProtectionRule: this.classicBranchProtectionRule
                    }
                  }
                }
              }),
          stderr: ''
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              object: this.policyText === null
                ? null
                : { text: this.policyText, oid: 'f'.repeat(40), byteSize: Buffer.byteLength(this.policyText) }
            }
          }
        }),
        stderr: ''
      };
    }
    const endpoint = args.find((arg) => typeof arg === 'string' && arg.startsWith('repos/'));
    if (endpoint === 'repos/acme/repo/pulls/7' && !args.includes('--method')) {
      return { exitCode: 0, stdout: JSON.stringify(this.pr), stderr: '' };
    }
    if (endpoint === 'repos/acme/repo/pulls?state=open&per_page=100') {
      return { exitCode: 0, stdout: JSON.stringify([this.#openPulls()]), stderr: '' };
    }
    if (endpoint === `repos/acme/repo/commits/${HEAD_OID}/check-runs?filter=latest&per_page=100`) {
      if (this.failCheckObservation) return { exitCode: 1, stdout: '', stderr: 'api unavailable' };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ total_count: this.checkRuns.length, check_runs: this.checkRuns }),
        stderr: ''
      };
    }
    if (endpoint === `repos/acme/repo/commits/${HEAD_OID}/status?per_page=100`) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ sha: HEAD_OID, total_count: this.statuses.length, statuses: this.statuses }),
        stderr: ''
      };
    }
    if (endpoint === 'repos/acme/repo') {
      return { exitCode: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' };
    }
    if (endpoint === 'repos/acme/repo/rules/branches/main?per_page=100') {
      return { exitCode: 0, stdout: JSON.stringify([this.rules]), stderr: '' };
    }
    if (endpoint === 'repos/acme/repo/branches/main') {
      return { exitCode: 0, stdout: JSON.stringify({ protected: this.branchProtected }), stderr: '' };
    }
    if (endpoint === 'repos/acme/repo/pulls/7/merge' && args.includes('--method')) {
      if (this.failNormalMerge) return { exitCode: 1, stdout: '', stderr: 'blocked' };
      assert.equal(args.includes(`sha=${HEAD_OID}`), true);
      assert.equal(args.includes('merge_method=squash'), true);
      this.#merge();
      return { exitCode: 0, stdout: JSON.stringify({ merged: true, sha: MERGE_OID }), stderr: '' };
    }
    throw new Error(`unexpected gh api invocation: ${args.join(' ')}`);
  }

  #merge() {
    this.pr.draft = false;
    this.pr.state = 'closed';
    this.pr.merged = true;
    this.pr.merged_at = '2026-09-09T04:00:00.000Z';
    this.pr.merge_commit_sha = MERGE_OID;
  }
}

async function fixture(t, runner = new DeliveryRunner()) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-pr-delivery-parent-'));
  const repositoryRoot = path.join(parent, 'repo');
  await fs.mkdir(path.join(repositoryRoot, '.git', 'projects-pr-v2'), { recursive: true });
  const plan = createProjectsPrPlan({
    repositoryRoot,
    packId: 'delivery-pack',
    title: 'Delivery policy',
    baseBranch: 'main',
    remote: 'origin',
    verificationCommand: 'npm run check'
  });
  runner.pr.head.ref = plan.branch;
  const state = {
    schemaVersion: 1,
    kind: 'projects-pr-state',
    packId: plan.packId,
    title: plan.title,
    repositoryRoot,
    baseBranch: plan.baseBranch,
    baseCommit: BASE_OID,
    remote: plan.remote,
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
    createdAt: '2026-09-09T03:00:00.000Z',
    updatedAt: '2026-09-09T03:30:00.000Z',
    verifiedCommit: HEAD_OID,
    pushedCommit: HEAD_OID,
    draftPullRequest: { number: 7, url: runner.pr.html_url, draft: true }
  };
  const statePath = path.join(repositoryRoot, '.git', 'projects-pr-v2', 'delivery-pack.json');
  runner.repositoryRoot = repositoryRoot;
  runner.statePath = statePath;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return {
    runner,
    repositoryRoot,
    statePath,
    input: { repositoryRoot, packId: 'delivery-pack' },
    dependencies: {
      runner: runner.invoke.bind(runner),
      now: () => '2026-09-09T04:00:00.000Z'
    }
  };
}

async function authorize(subject) {
  return authorizeProjectsPr({
    ...subject.input,
    reviewedHead: HEAD_OID,
    confirmReview: true,
    confirmOwner: true
  }, subject.dependencies);
}

test('delivery commands parse explicit confirmations and repeated admin bypasses', () => {
  assert.deepEqual(parseProjectsPrArgs([
    'authorize', '--pack-id', 'p', '--reviewed-head', HEAD_OID,
    '--confirm-review', '--confirm-owner'
  ]), {
    command: 'authorize', packId: 'p', reviewedHead: HEAD_OID,
    confirmReview: true, confirmOwner: true, repositoryRoot: path.resolve(process.cwd())
  });
  assert.deepEqual(parseProjectsPrArgs([
    'authorize-admin', '--pack-id', 'p', '--reviewed-head', HEAD_OID,
    '--confirm-review', '--confirm-owner', '--reason', 'owner approved',
    '--bypass', 'github Rial', '--bypass', 'github Other'
  ]).bypassedRequirements, ['github Rial', 'github Other']);
});

test('delivery fixture distinguishes local lock discovery from bounded delivery effects', () => {
  for (const flag of ['--show-toplevel', '--git-common-dir']) {
    const discovery = { executable: 'git', args: ['rev-parse', flag], timeoutMs: 10_000 };
    assert.doesNotThrow(() => assertInvocationTimeout(discovery));
    assert.throws(() => assertInvocationTimeout({ ...discovery, timeoutMs: 30_000 }));
    assert.throws(() => assertInvocationTimeout({ ...discovery, timeoutMs: 0 }));
  }
  for (const effect of [
    { executable: 'gh', args: ['api', 'repos/acme/repo/pulls/7/merge'] },
    { executable: 'git', args: ['push', 'origin', ':refs/heads/topic'] },
    { executable: 'git', args: ['ls-remote', '--heads', 'origin', 'refs/heads/topic'] }
  ]) {
    assert.doesNotThrow(() => assertInvocationTimeout({ ...effect, timeoutMs: 30_000 }));
    assert.throws(() => assertInvocationTimeout({ ...effect, timeoutMs: 10_000 }));
    assert.throws(() => assertInvocationTimeout({ ...effect, timeoutMs: 0 }));
  }
});

test('missing trusted policy keeps merge, cleanup, and admin options off', async (t) => {
  const subject = await fixture(t);
  subject.runner.policyText = null;
  await assert.rejects(authorize(subject), (error) => {
    assert.equal(error.code, 'reviewed_merge_disabled');
    return true;
  });
  assert.equal(subject.runner.calls.some((call) => call.args?.includes('--method')), false);
});

test('an off merge toggle may retain valid settings without authorizing effects', async (t) => {
  const subject = await fixture(t);
  subject.runner.policyText = policy({
    reviewedMerge: {
      enabled: false,
      method: 'squash',
      requiredChecks: [{ kind: 'check-run', name: 'ci', publisherId: 15368 }]
    }
  });
  await assert.rejects(authorize(subject), (error) => {
    assert.equal(error.code, 'reviewed_merge_disabled');
    return true;
  });
  assert.equal(subject.runner.pr.draft, true);
  assert.equal(subject.runner.calls.some((call) => call.args?.includes('--method')), false);
});

test('reviewed finish rechecks exact published checks, merges one PR, and lease-deletes only the remote branch', async (t) => {
  const subject = await fixture(t);
  const approved = await authorize(subject);
  assert.equal(approved.status, 'authorized');
  assert.equal(approved.result.authorization.review.independentGitHubApproval, false);
  assert.equal(approved.result.authorization.pullRequest.headOid, HEAD_OID);
  const policyRead = subject.runner.calls.find((call) => call.args?.[1] === 'graphql');
  assert.equal(policyRead.args.includes(`expression=${BASE_OID}:.github/projects-pr-policy.json`), true);
  assert.equal(policyRead.args.some((arg) => arg === `expression=${HEAD_OID}:.github/projects-pr-policy.json`), false);
  const receipt = await finishProjectsPr(subject.input, subject.dependencies);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.result.merge.headOid, HEAD_OID);
  assert.equal(receipt.result.cleanup.status, 'deleted');
  assert.equal(receipt.result.cleanup.deletedByController, true);
  assert.equal(subject.runner.calls.filter((call) => call.executable === 'gh')
    .every((call) => call.timeoutMs === 30_000), true);
  const merge = subject.runner.calls.find((call) => call.executable === 'gh'
    && call.args.includes('repos/acme/repo/pulls/7/merge'));
  assert.ok(merge);
  assert.equal(merge.args.includes('--auto'), false);
  const deletion = subject.runner.calls.find((call) => call.executable === 'git'
    && call.args[0] === 'push');
  assert.deepEqual(deletion.args, [
    'push', `--force-with-lease=refs/heads/${subject.runner.pr.head.ref}:${HEAD_OID}`,
    'origin', `:refs/heads/${subject.runner.pr.head.ref}`
  ]);
});

test('pending, skipped, missing, stale-sha, failed, and ambiguous checks never mutate the PR', async (t) => {
  const variants = [
    [{ ...new DeliveryRunner().checkRuns[0], status: 'queued', conclusion: 'success' }, 'queued'],
    [{ ...new DeliveryRunner().checkRuns[0], conclusion: 'skipped' }, 'skipped'],
    [null, 'missing'],
    [{ ...new DeliveryRunner().checkRuns[0], head_sha: CHANGED_OID }, 'stale-sha'],
    [{ ...new DeliveryRunner().checkRuns[0], conclusion: 'failure' }, 'failure'],
    [{ ...new DeliveryRunner().checkRuns[0], app: { id: 999 } }, 'missing']
  ];
  for (const [run, expected] of variants) {
    const subject = await fixture(t);
    await authorize(subject);
    subject.runner.checkRuns = run ? [run] : [];
    const receipt = await finishProjectsPr(subject.input, subject.dependencies);
    assert.equal(receipt.status, 'waiting');
    assert.equal(receipt.result.checks.required[0].outcome, expected);
    assert.equal(subject.runner.pr.draft, true);
    assert.equal(subject.runner.calls.some((call) => call.args?.includes('--method')), false);
  }
  const subject = await fixture(t);
  await authorize(subject);
  subject.runner.checkRuns.push({ ...subject.runner.checkRuns[0] });
  const ambiguous = await finishProjectsPr(subject.input, subject.dependencies);
  assert.equal(ambiguous.result.checks.required[0].outcome, 'ambiguous');
  assert.equal(subject.runner.pr.draft, true);
});

test('status-context publisher identity is enforced and check API errors never merge', async (t) => {
  const status = await fixture(t);
  status.runner.policyText = policy({
    reviewedMerge: {
      enabled: true,
      method: 'squash',
      requiredChecks: [{ kind: 'status-context', name: 'external/ci', publisherId: 91 }]
    }
  });
  status.runner.statuses = [{ context: 'external/ci', creator: { id: 91 }, state: 'success' }];
  await authorize(status);
  const receipt = await finishProjectsPr(status.input, status.dependencies);
  assert.equal(receipt.status, 'completed');

  const unavailable = await fixture(t);
  await authorize(unavailable);
  unavailable.runner.failCheckObservation = true;
  await assert.rejects(finishProjectsPr(unavailable.input, unavailable.dependencies), (error) => {
    assert.equal(error.code, 'github_delivery_observation_failed');
    return true;
  });
  assert.equal(unavailable.runner.pr.draft, true);
  assert.equal(unavailable.runner.pr.merged, false);
});

test('new head or base after authorization invalidates review without following it', async (t) => {
  const head = await fixture(t);
  await authorize(head);
  head.runner.pr.head.sha = CHANGED_OID;
  await assert.rejects(finishProjectsPr(head.input, head.dependencies), (error) => {
    assert.equal(error.code, 'delivery_identity_mismatch');
    return true;
  });
  assert.equal(head.runner.pr.merged, false);

  const base = await fixture(t);
  await authorize(base);
  base.runner.pr.base.sha = CHANGED_OID;
  await assert.rejects(finishProjectsPr(base.input, base.dependencies), (error) => {
    assert.equal(error.code, 'stale_delivery_authorization');
    return true;
  });
  assert.equal(base.runner.pr.merged, false);
});

test('unknown policy fields and stacked dependencies fail loudly before authorization', async (t) => {
  const malformed = await fixture(t);
  malformed.runner.policyText = policy({ surprise: true });
  await assert.rejects(authorize(malformed), (error) => {
    assert.equal(error.code, 'invalid_delivery_policy');
    return true;
  });
  const stacked = await fixture(t);
  stacked.runner.openExtras = [{
    number: 8,
    base: { ref: stacked.runner.pr.head.ref },
    head: { ref: 'dependent', repo: { full_name: 'acme/repo' } }
  }];
  await assert.rejects(authorize(stacked), (error) => {
    assert.equal(error.code, 'stacked_or_shared_branch');
    return true;
  });
});

test('admin authorization is separate, exact, and limited to observable ruleset bypasses', async (t) => {
  const subject = await fixture(t);
  subject.runner.policyText = policy({ adminOverride: { enabled: true } });
  subject.runner.branchProtected = true;
  subject.runner.rules = [{
    type: 'pull_request', ruleset_id: 42,
    parameters: { required_approving_review_count: 1 }
  }];
  const approved = await authorizeAdminProjectsPr({
    ...subject.input,
    reviewedHead: HEAD_OID,
    confirmReview: true,
    confirmOwner: true,
    reason: 'Owner accepts the named GitHub review-rule bypass.',
    bypassedRequirements: ['github-ruleset:pull-request']
  }, subject.dependencies);
  assert.equal(approved.result.authorization.mode, 'admin');
  assert.deepEqual(approved.result.authorization.override.bypassedRequirements,
    ['github-ruleset:pull-request']);
  subject.runner.pr.mergeable_state = 'blocked';
  const receipt = await finishProjectsPr(subject.input, subject.dependencies);
  assert.equal(receipt.status, 'completed');
  const admin = subject.runner.calls.find((call) => call.args?.[0] === 'pr'
    && call.args?.[1] === 'merge');
  assert.ok(admin);
  assert.equal(admin.args.includes('--admin'), true);
  assert.equal(admin.args.includes('--match-head-commit'), true);
});

test('admin authorization is invalidated when rule parameters change without changing type', async (t) => {
  const subject = await fixture(t);
  subject.runner.policyText = policy({ adminOverride: { enabled: true } });
  subject.runner.rules = [{
    type: 'pull_request', ruleset_id: 42,
    parameters: { required_approving_review_count: 1 }
  }];
  await authorizeAdminProjectsPr({
    ...subject.input,
    reviewedHead: HEAD_OID,
    confirmReview: true,
    confirmOwner: true,
    reason: 'Owner accepts one observed rule.',
    bypassedRequirements: ['github-ruleset:pull-request']
  }, subject.dependencies);
  subject.runner.rules[0].parameters.required_approving_review_count = 2;
  subject.runner.pr.mergeable_state = 'blocked';
  await assert.rejects(finishProjectsPr(subject.input, subject.dependencies), (error) => {
    assert.equal(error.code, 'stale_admin_authorization');
    return true;
  });
  assert.equal(subject.runner.pr.draft, true);
});

test('admin refuses incomplete or actual classic protection and repository-required checks', async (t) => {
  const hidden = await fixture(t);
  hidden.runner.policyText = policy({ adminOverride: { enabled: true } });
  hidden.runner.rules = [{ type: 'pull_request', ruleset_id: 42, parameters: {} }];
  hidden.runner.branchProtected = true;
  hidden.runner.viewerPermission = 'WRITE';
  await assert.rejects(authorizeAdminProjectsPr({
    ...hidden.input,
    reviewedHead: HEAD_OID,
    confirmReview: true,
    confirmOwner: true,
    reason: 'Owner request',
    bypassedRequirements: ['github-ruleset:pull-request']
  }, hidden.dependencies), (error) => {
    assert.equal(error.code, 'admin_requirements_unavailable');
    return true;
  });

  const graphqlError = await fixture(t);
  graphqlError.runner.policyText = policy({ adminOverride: { enabled: true } });
  graphqlError.runner.rules = [{ type: 'pull_request', ruleset_id: 42, parameters: {} }];
  graphqlError.runner.branchProtected = true;
  graphqlError.runner.failClassicProtectionObservation = true;
  await assert.rejects(authorizeAdminProjectsPr({
    ...graphqlError.input,
    reviewedHead: HEAD_OID,
    confirmReview: true,
    confirmOwner: true,
    reason: 'Owner request',
    bypassedRequirements: ['github-ruleset:pull-request']
  }, graphqlError.dependencies), (error) => {
    assert.equal(error.code, 'admin_requirements_unavailable');
    return true;
  });

  const transportError = await fixture(t);
  transportError.runner.policyText = policy({ adminOverride: { enabled: true } });
  transportError.runner.rules = [{ type: 'pull_request', ruleset_id: 42, parameters: {} }];
  transportError.runner.branchProtected = true;
  transportError.runner.classicProtectionExitCode = 1;
  await assert.rejects(authorizeAdminProjectsPr({
    ...transportError.input,
    reviewedHead: HEAD_OID,
    confirmReview: true,
    confirmOwner: true,
    reason: 'Owner request',
    bypassedRequirements: ['github-ruleset:pull-request']
  }, transportError.dependencies), (error) => {
    assert.equal(error.code, 'admin_requirements_unavailable');
    return true;
  });

  const classic = await fixture(t);
  classic.runner.policyText = policy({ adminOverride: { enabled: true } });
  classic.runner.rules = [{ type: 'pull_request', ruleset_id: 42, parameters: {} }];
  classic.runner.branchProtected = true;
  classic.runner.classicBranchProtectionRule = { id: 'BPR_test', pattern: 'main' };
  await assert.rejects(authorizeAdminProjectsPr({
    ...classic.input,
    reviewedHead: HEAD_OID,
    confirmReview: true,
    confirmOwner: true,
    reason: 'Owner request',
    bypassedRequirements: ['github-ruleset:pull-request']
  }, classic.dependencies), (error) => {
    assert.equal(error.code, 'unsupported_admin_requirements');
    return true;
  });

  const checks = await fixture(t);
  checks.runner.policyText = policy({ adminOverride: { enabled: true } });
  checks.runner.rules = [{
    type: 'required_status_checks', ruleset_id: 43,
    parameters: { required_status_checks: [{ context: 'ci', integration_id: 15368 }] }
  }];
  await assert.rejects(authorizeAdminProjectsPr({
    ...checks.input,
    reviewedHead: HEAD_OID,
    confirmReview: true,
    confirmOwner: true,
    reason: 'Owner request',
    bypassedRequirements: ['github-ruleset:pull-request']
  }, checks.dependencies), (error) => {
    assert.equal(error.code, 'unsupported_admin_requirements');
    return true;
  });
});

test('a merge that succeeds before state receipt failure is recovered without a second merge', async (t) => {
  const subject = await fixture(t);
  await authorize(subject);
  let failed = false;
  const flakyFs = {
    // Preserve real lock I/O while injecting only the original state-rename fault.
    ...fs,
    rename: async (...args) => {
      if (subject.runner.pr.merged && !failed) {
        failed = true;
        throw new Error('simulated receipt failure');
      }
      return fs.rename(...args);
    }
  };
  await assert.rejects(finishProjectsPr(subject.input, {
    ...subject.dependencies,
    fs: flakyFs
  }));
  assert.equal(subject.runner.pr.merged, true);
  const firstMergeCount = subject.runner.calls.filter((call) => call.args?.includes('--method')).length;
  const recovered = await finishProjectsPr(subject.input, subject.dependencies);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result.resumed, true);
  assert.equal(subject.runner.calls.filter((call) => call.args?.includes('--method')).length, firstMergeCount);
});

test('the non-bypassable frozen repository deny stops authorization before GitHub observation', async (t) => {
  const subject = await fixture(t);
  const state = JSON.parse(await fs.readFile(subject.statePath, 'utf8'));
  state.github = {
    host: 'github.com',
    nameWithOwner: 'wornpage/projects-webmcp-extension',
    repositorySpecifier: 'github.com/wornpage/projects-webmcp-extension'
  };
  await fs.writeFile(subject.statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(authorize(subject), (error) => {
    assert.equal(error.code, 'frozen_repository');
    return true;
  });
  assert.equal(subject.runner.calls.some((call) => call.executable === 'gh'), false);
});

test('normal merge failure never falls back to admin and unknown readiness is refused', async (t) => {
  const subject = await fixture(t);
  await authorize(subject);
  subject.runner.failNormalMerge = true;
  await assert.rejects(finishProjectsPr(subject.input, subject.dependencies), (error) => {
    assert.equal(error.code, 'reviewed_merge_refused');
    return true;
  });
  assert.equal(subject.runner.calls.some((call) => call.args?.includes('--admin')), false);

  const unknown = await fixture(t);
  await authorize(unknown);
  unknown.runner.pr.mergeable_state = 'unknown';
  await assert.rejects(finishProjectsPr(unknown.input, unknown.dependencies), (error) => {
    assert.equal(error.code, 'ordinary_merge_not_clean');
    return true;
  });
  assert.equal(unknown.runner.pr.merged, false);
});

test('cleanup rejects changed refs, multiple push URLs, mirrors, custom ports, and lease races', async (t) => {
  const mutations = [
    (runner) => { runner.remoteOid = CHANGED_OID; },
    (runner) => { runner.pushUrls.push('https://github.com/acme/repo.git'); },
    (runner) => { runner.remoteMirror = ['true']; },
    (runner) => { runner.pushUrls = ['https://github.com:8443/acme/repo.git']; },
    (runner) => { runner.raceDelete = true; }
  ];
  for (const mutate of mutations) {
    const subject = await fixture(t);
    await authorize(subject);
    mutate(subject.runner);
    await assert.rejects(finishProjectsPr(subject.input, subject.dependencies));
    assert.equal(subject.runner.remoteOid === null, false);
  }
});

test('terminal already-absent cleanup never deletes a recreated branch on retry', async (t) => {
  const subject = await fixture(t);
  await authorize(subject);
  subject.runner.remoteOid = null;
  const first = await finishProjectsPr(subject.input, subject.dependencies);
  assert.equal(first.result.cleanup.status, 'already-absent');
  subject.runner.remoteOid = HEAD_OID;
  await assert.rejects(finishProjectsPr(subject.input, subject.dependencies), (error) => {
    assert.equal(error.code, 'remote_branch_reappeared');
    return true;
  });
  assert.equal(subject.runner.calls.filter((call) => call.args?.[0] === 'push').length, 0);
});

test('an exact git deletion lease rejects a ref changed after the reviewed SHA', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-pr-lease-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'remote.git');
  const work = path.join(parent, 'work');
  execFileSync('git', ['init', '--bare', '--initial-branch=topic', remote]);
  execFileSync('git', ['init', '--initial-branch=topic', work]);
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: work });
  execFileSync('git', ['config', 'user.name', 'Lease Test'], { cwd: work });
  await fs.writeFile(path.join(work, 'evidence.txt'), 'reviewed\n');
  execFileSync('git', ['add', 'evidence.txt'], { cwd: work });
  execFileSync('git', ['commit', '-m', 'reviewed'], { cwd: work });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: work });
  execFileSync('git', ['push', '-u', 'origin', 'topic'], { cwd: work });
  const reviewed = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(work, 'evidence.txt'), 'changed\n');
  execFileSync('git', ['commit', '-am', 'changed'], { cwd: work });
  execFileSync('git', ['push', 'origin', 'topic'], { cwd: work });
  const changed = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  assert.throws(() => execFileSync('git', [
    'push', `--force-with-lease=refs/heads/topic:${reviewed}`,
    'origin', ':refs/heads/topic'
  ], { cwd: work, stdio: 'pipe' }));
  const remoteOid = execFileSync('git', ['ls-remote', '--heads', 'origin', 'refs/heads/topic'], {
    cwd: work, encoding: 'utf8'
  }).trim().split(/\s+/u)[0];
  assert.equal(remoteOid, changed);
});
