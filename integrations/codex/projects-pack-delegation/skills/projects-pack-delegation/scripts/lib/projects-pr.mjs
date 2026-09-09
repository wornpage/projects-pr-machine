import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_COMMAND_LENGTH = 2000;
const SAFE_PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SAFE_GIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u;
const SAFE_GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/u;
const SAFE_OID = /^[0-9a-f]{40,64}$/iu;
const STATE_KIND = 'projects-pr-state';
const STATE_PHASES = new Set(['preparing', 'prepared', 'pushed', 'pr_created', 'completed', 'aborted']);
const DELIVERY_POLICY_PATH = '.github/projects-pr-policy.json';
const DELIVERY_POLICY_SCHEMA_VERSION = 1;
const DELIVERY_EFFECT_TIMEOUT_MS = 30_000;
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const FROZEN_REPOSITORIES = new Set(['github.com/wornpage/projects-webmcp-extension']);
const ADMIN_BYPASS_RULES = new Map([
  ['pull_request', 'github-ruleset:pull-request'],
  ['merge_queue', 'github-ruleset:merge-queue'],
  ['update', 'github-ruleset:update']
]);
const ADMIN_IRRELEVANT_RULES = new Set(['creation', 'deletion', 'non_fast_forward']);

export const PROJECTS_PR_SCHEMA_VERSION = 2;
export const PROJECTS_PR_STATE_SCHEMA_VERSION = 1;
export const PROJECTS_PR_DELIVERY_POLICY_PATH = DELIVERY_POLICY_PATH;
export const PROJECTS_PR_CONSTRAINTS = Object.freeze({
  energy: 'low',
  workerCount: 1,
  draftOnly: true
});
export const PROJECTS_PR_OWNER_DECISION = Object.freeze({
  state: 'owner_review_required',
  recommendation: 'Review the draft pull request and merge only after explicit owner approval.',
  merge: Object.freeze({ ownerControlled: true, autoMerge: false, status: 'not_requested' })
});

export class ProjectsPrError extends Error {
  constructor(message, { code = 'projects_pr_failed', receipt = null, exitCode = null } = {}) {
    super(message);
    this.name = 'ProjectsPrError';
    this.code = code;
    this.receipt = receipt;
    this.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  }
}

function normalizedText(value, label, maxLength = 500) {
  const result = String(value ?? '').trim();
  if (!result || result.length > maxLength) {
    throw new ProjectsPrError(`${label} must be a nonempty string no longer than ${maxLength} characters.`, {
      code: 'invalid_input'
    });
  }
  return result;
}

function safePackId(value) {
  const result = normalizedText(value, 'packId', 120);
  if (!SAFE_PACK_ID.test(result)) {
    throw new ProjectsPrError('packId may contain only letters, numbers, dot, underscore, and hyphen.', {
      code: 'invalid_input'
    });
  }
  return result;
}

function safeGitName(value, label) {
  const result = normalizedText(value, label, 120);
  if (!SAFE_GIT_NAME.test(result)
    || result.includes('..')
    || result.includes('//')
    || result.endsWith('.')
    || result.endsWith('/')
    || result.includes('@{')) {
    throw new ProjectsPrError(`${label} is not a safe Git name.`, { code: 'invalid_input' });
  }
  return result;
}

function commandText(value, label) {
  const result = normalizedText(value, label, MAX_COMMAND_LENGTH);
  if (/\0|\r|\n/u.test(result)) {
    throw new ProjectsPrError(`${label} must be a single-line command.`, { code: 'invalid_input' });
  }
  return result;
}

function slug(value, maxLength) {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, maxLength)
    .replace(/-+$/u, '');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function samePath(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function boundedVersion(value) {
  return String(value ?? '').split(/\r?\n/u)[0].trim().slice(0, 160) || null;
}

function parseMajor(version) {
  const match = String(version ?? '').trim().match(/(?:^|\s|v)(\d+)(?:\.|$)/u);
  return match ? Number(match[1]) : null;
}

export function parseGitHubRemote(remoteUrl) {
  const value = normalizedText(remoteUrl, 'remote URL', 1000);
  let host;
  let pathname;
  if (/^https:\/\//iu.test(value) || /^ssh:\/\//iu.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ProjectsPrError('Remote must be a GitHub HTTPS or SSH URL.', { code: 'non_github_remote' });
    }
    const invalidUser = parsed.protocol === 'https:' ? Boolean(parsed.username) : Boolean(parsed.username && parsed.username !== 'git');
    if (!['https:', 'ssh:'].includes(parsed.protocol)
      || parsed.password
      || invalidUser
      || parsed.search
      || parsed.hash) {
      throw new ProjectsPrError('Remote must be a credential-free GitHub HTTPS or SSH URL.', {
        code: 'non_github_remote'
      });
    }
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } else {
    const scp = value.match(/^git@([^:/\s]+):([^\s]+)$/u);
    if (!scp) {
      throw new ProjectsPrError('Remote must be a GitHub HTTPS or SSH URL.', { code: 'non_github_remote' });
    }
    [, host, pathname] = scp;
    host = host.toLowerCase();
  }
  const segments = pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '').split('/');
  if (segments.length !== 2 || segments.some((segment) => !SAFE_GITHUB_SEGMENT.test(segment))) {
    throw new ProjectsPrError('Remote must identify one GitHub owner/repository pair.', {
      code: 'non_github_remote'
    });
  }
  const nameWithOwner = `${segments[0]}/${segments[1]}`;
  return Object.freeze({ host, nameWithOwner, repositorySpecifier: `${host}/${nameWithOwner}` });
}

export function createProjectsPrPlan(input = {}) {
  const repositoryRoot = path.resolve(normalizedText(input.repositoryRoot ?? process.cwd(), 'repositoryRoot', 1000));
  const packId = safePackId(input.packId);
  const title = normalizedText(input.title, 'title', 200);
  const baseBranch = safeGitName(input.baseBranch, 'baseBranch');
  const remote = safeGitName(input.remote ?? 'origin', 'remote');
  const verificationCommand = commandText(input.verificationCommand, 'verificationCommand');
  const packSlug = slug(packId, 48);
  const titleSlug = slug(title, 40) || 'change';
  const branch = safeGitName(`projects-pr/${packSlug}-${titleSlug}`, 'derived branch');
  const repositoryName = slug(path.basename(repositoryRoot), 48) || 'repository';
  const worktreePath = path.resolve(path.dirname(repositoryRoot), '.projects-pr-worktrees', `${repositoryName}-${packSlug}`);
  if (samePath(worktreePath, repositoryRoot) || isInside(repositoryRoot, worktreePath)) {
    throw new ProjectsPrError('The derived worktree must be outside the repository checkout.', {
      code: 'invalid_input'
    });
  }
  return Object.freeze({
    repositoryRoot,
    packId,
    title,
    baseBranch,
    remote,
    branch,
    worktreePath,
    verificationCommand,
    verificationCommandSha256: sha256(verificationCommand)
  });
}

export async function defaultProjectsPrRunner(invocation) {
  const { executable, args = [], cwd, shell = false, timeoutMs } = invocation;
  const command = shell ? (process.platform === 'win32' ? 'pwsh' : '/bin/sh') : executable;
  const commandArgs = shell
    ? (process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', executable]
      : ['-c', executable])
    : args;
  try {
    const result = await execFileAsync(command, commandArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      windowsHide: true
    });
    return { exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? ''
    };
  }
}

async function invoke(runner, executable, args, cwd, shell = false) {
  const result = await runner({ executable, args, cwd, shell });
  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 1,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? '')
  };
}

async function invokeBounded(runner, executable, args, cwd) {
  const result = await runner({
    executable,
    args,
    cwd,
    shell: false,
    timeoutMs: DELIVERY_EFFECT_TIMEOUT_MS
  });
  return {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 1,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? '')
  };
}

async function checked(runner, executable, args, cwd, label, allowedExitCodes = [0], shell = false) {
  const result = await invoke(runner, executable, args, cwd, shell);
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new ProjectsPrError(`${label} failed.`, { code: 'command_failed', exitCode: result.exitCode });
  }
  return result;
}

async function git(runner, repositoryRoot, args, label, cwd = repositoryRoot, allowedExitCodes = [0]) {
  return checked(runner, 'git', args, cwd, label, allowedExitCodes, false);
}

function check(id, passed, code, detail = null, exitCode = null) {
  return {
    id,
    passed,
    code: passed ? 'ok' : code,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    detail: detail ? boundedVersion(detail) : null
  };
}

function doctorReceipt({ status, repositoryRoot, baseBranch, remote, github, gitCommonDir, checks, stackRequested }) {
  return {
    schemaVersion: PROJECTS_PR_SCHEMA_VERSION,
    kind: 'projects-pr',
    command: 'doctor',
    status,
    constraints: { ...PROJECTS_PR_CONSTRAINTS },
    repository: {
      root: repositoryRoot,
      baseBranch: baseBranch ?? null,
      remote,
      gitCommonDir: gitCommonDir ?? null,
      github: github ? { host: github.host, nameWithOwner: github.nameWithOwner } : null
    },
    capability: {
      available: status === 'ready',
      stackRequested,
      checks
    }
  };
}

export async function runProjectsPrDoctor(input = {}, dependencies = {}) {
  const runner = dependencies.runner ?? defaultProjectsPrRunner;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const repositoryRoot = path.resolve(normalizedText(input.repositoryRoot ?? process.cwd(), 'repositoryRoot', 1000));
  const remote = safeGitName(input.remote ?? 'origin', 'remote');
  const requestedBase = input.baseBranch === undefined ? null : safeGitName(input.baseBranch, 'baseBranch');
  const stackRequested = input.stack === true;
  const checks = [];
  let baseBranch = requestedBase;
  let github = null;
  let gitCommonDir = null;

  const nodeMajor = parseMajor(nodeVersion);
  const nodeReady = nodeMajor !== null && nodeMajor >= 22;
  checks.push(check('node', nodeReady, 'node_22_required', `Node ${nodeVersion}`, nodeReady ? 0 : 1));

  const gitVersion = await invoke(runner, 'git', ['--version'], repositoryRoot);
  checks.push(check('git', gitVersion.exitCode === 0, 'git_unavailable', gitVersion.exitCode === 0 ? gitVersion.stdout : null, gitVersion.exitCode));

  const shellExecutable = process.platform === 'win32' ? 'pwsh' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'] : ['-c', 'exit 0'];
  const shellResult = await invoke(runner, shellExecutable, shellArgs, repositoryRoot);
  const shellMajor = process.platform === 'win32' ? parseMajor(shellResult.stdout) : 7;
  const shellReady = shellResult.exitCode === 0 && (process.platform !== 'win32' || (shellMajor !== null && shellMajor >= 7));
  checks.push(check('shell', shellReady, process.platform === 'win32' ? 'powershell_7_required' : 'shell_unavailable', shellReady ? (process.platform === 'win32' ? `PowerShell ${shellMajor}` : '/bin/sh') : null, shellResult.exitCode));

  if (gitVersion.exitCode === 0) {
    const top = await invoke(runner, 'git', ['rev-parse', '--show-toplevel'], repositoryRoot);
    const topLevel = top.stdout.trim();
    const topReady = top.exitCode === 0 && samePath(topLevel, repositoryRoot);
    checks.push(check('repository_top_level', topReady, 'unsafe_repository', null, top.exitCode));

    if (topReady) {
      const status = await invoke(runner, 'git', ['status', '--porcelain=v1', '--untracked-files=normal'], repositoryRoot);
      checks.push(check('repository_clean', status.exitCode === 0 && !status.stdout.trim(), 'dirty_repository', null, status.exitCode));

      const current = await invoke(runner, 'git', ['branch', '--show-current'], repositoryRoot);
      const currentBranch = current.stdout.trim();
      if (!baseBranch && current.exitCode === 0 && currentBranch) baseBranch = currentBranch;
      const currentReady = current.exitCode === 0 && Boolean(baseBranch) && currentBranch === baseBranch;
      checks.push(check('base_checked_out', currentReady, 'wrong_base_branch', null, current.exitCode));

      const base = baseBranch
        ? await invoke(runner, 'git', ['rev-parse', '--verify', `refs/heads/${baseBranch}`], repositoryRoot)
        : { exitCode: 1 };
      const localBaseOid = parseOidLine(base.stdout);
      checks.push(check('base_reference', base.exitCode === 0 && Boolean(localBaseOid), 'base_reference_missing', null, base.exitCode));

      const common = await invoke(runner, 'git', ['rev-parse', '--git-common-dir'], repositoryRoot);
      if (common.exitCode === 0 && common.stdout.trim()) {
        gitCommonDir = path.resolve(repositoryRoot, common.stdout.trim());
      }
      checks.push(check('git_common_dir', Boolean(gitCommonDir), 'git_common_dir_unavailable', null, common.exitCode));

      const remoteResult = await invoke(runner, 'git', ['remote', 'get-url', remote], repositoryRoot);
      if (remoteResult.exitCode === 0) {
        try {
          github = parseGitHubRemote(remoteResult.stdout.trim());
          checks.push(check('github_remote', true, 'non_github_remote', null, remoteResult.exitCode));
        } catch {
          checks.push(check('github_remote', false, 'non_github_remote', null, remoteResult.exitCode));
        }
      } else {
        checks.push(check('github_remote', false, 'remote_unavailable', null, remoteResult.exitCode));
      }

      const remoteBase = baseBranch
        ? await invoke(runner, 'git', ['ls-remote', '--heads', remote, `refs/heads/${baseBranch}`], repositoryRoot)
        : { exitCode: 1, stdout: '' };
      const remoteBaseOid = parseOidLine(remoteBase.stdout);
      const remoteAccessReady = remoteBase.exitCode === 0 && Boolean(remoteBaseOid);
      checks.push(check('remote_access', remoteAccessReady, 'remote_access_failed', null, remoteBase.exitCode));
      if (localBaseOid && remoteAccessReady) {
        const remoteBaseMatches = remoteBaseOid === localBaseOid;
        checks.push(check(
          'remote_base_oid',
          remoteBaseMatches,
          'remote_base_mismatch',
          remoteBaseMatches ? null : `local=${localBaseOid}; remote=${remoteBaseOid}`,
          remoteBase.exitCode
        ));
      }
    }
  }

  const ghVersion = await invoke(runner, 'gh', ['--version'], repositoryRoot);
  checks.push(check('github_cli', ghVersion.exitCode === 0, 'github_cli_unavailable', ghVersion.exitCode === 0 ? ghVersion.stdout : null, ghVersion.exitCode));
  if (ghVersion.exitCode === 0 && github) {
    const auth = await invoke(runner, 'gh', ['auth', 'status', '--hostname', github.host], repositoryRoot);
    checks.push(check('github_auth', auth.exitCode === 0, 'github_auth_unavailable', null, auth.exitCode));
    const api = auth.exitCode === 0
      ? await invoke(runner, 'gh', [
        'api', '--hostname', github.host, `repos/${github.nameWithOwner}`,
        '--jq', '{fullName: .full_name, push: .permissions.push}'
      ], repositoryRoot)
      : { exitCode: 1, stdout: '' };
    let repositoryAccess = null;
    if (api.exitCode === 0) {
      try {
        repositoryAccess = JSON.parse(api.stdout);
      } catch {
        repositoryAccess = null;
      }
    }
    const exactRepo = String(repositoryAccess?.fullName ?? '').toLowerCase() === github.nameWithOwner.toLowerCase();
    const canPush = exactRepo && repositoryAccess?.push === true;
    checks.push(check(
      'github_repository',
      canPush,
      exactRepo ? 'github_push_unavailable' : 'github_repository_unavailable',
      null,
      api.exitCode
    ));
  } else {
    checks.push(check('github_auth', false, 'github_auth_unavailable', null, null));
    checks.push(check('github_repository', false, 'github_repository_unavailable', null, null));
  }

  if (stackRequested) {
    const extensions = ghVersion.exitCode === 0
      ? await invoke(runner, 'gh', ['extension', 'list'], repositoryRoot)
      : { exitCode: 1, stdout: '' };
    const officialExtension = extensions.exitCode === 0
      && extensions.stdout.split(/\r?\n/gu).some((line) => {
        const fields = line.trim().split(/\s+/u);
        return fields[0] === 'gh' && fields[1] === 'stack' && fields[2] === 'github/gh-stack';
      });
    checks.push(check(
      'github_stack_extension',
      officialExtension,
      'github_stack_extension_unavailable',
      officialExtension ? 'github/gh-stack' : null,
      extensions.exitCode
    ));
    const stackVersion = officialExtension
      ? await invoke(runner, 'gh', ['stack', '--version'], repositoryRoot)
      : { exitCode: 1, stdout: '' };
    checks.push(check(
      'github_stack_command',
      stackVersion.exitCode === 0,
      'github_stack_command_unavailable',
      stackVersion.exitCode === 0 ? stackVersion.stdout : null,
      stackVersion.exitCode
    ));
    const linkHelp = stackVersion.exitCode === 0
      ? await invoke(runner, 'gh', ['stack', 'link', '--help'], repositoryRoot)
      : { exitCode: 1, stdout: '' };
    checks.push(check(
      'github_stack_link',
      linkHelp.exitCode === 0 && /--base\s+string/u.test(linkHelp.stdout) && /--remote\s+string/u.test(linkHelp.stdout),
      'github_stack_link_unavailable',
      null,
      linkHelp.exitCode
    ));
  }

  const ready = checks.every((item) => item.passed);
  return doctorReceipt({
    status: ready ? 'ready' : 'unavailable',
    repositoryRoot,
    baseBranch,
    remote,
    github,
    gitCommonDir,
    checks,
    stackRequested
  });
}

function statePathFor(doctor, packId) {
  if (!doctor.repository.gitCommonDir) {
    throw new ProjectsPrError('Git common directory is unavailable.', { code: 'git_common_dir_unavailable' });
  }
  return path.join(doctor.repository.gitCommonDir, 'projects-pr-v2', `${safePackId(packId)}.json`);
}

async function pathExists(fsApi, candidate) {
  try {
    await fsApi.access(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeState(fsApi, statePath, state) {
  await fsApi.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  await fsApi.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fsApi.chmod(temporary, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  await fsApi.rename(temporary, statePath);
}

async function readState(fsApi, statePath, repositoryRoot, packId) {
  let state;
  try {
    state = JSON.parse(await fsApi.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ProjectsPrError(`No projects-pr state exists for ${packId}.`, { code: 'state_not_found' });
    }
    throw new ProjectsPrError('projects-pr state is unreadable or invalid JSON.', { code: 'invalid_state' });
  }
  if (state?.schemaVersion !== PROJECTS_PR_STATE_SCHEMA_VERSION
    || state?.kind !== STATE_KIND
    || state?.packId !== packId
    || !STATE_PHASES.has(state?.phase)
    || !samePath(state?.repositoryRoot ?? '', repositoryRoot)) {
    throw new ProjectsPrError('projects-pr state does not match this repository and pack.', { code: 'invalid_state' });
  }
  const plan = createProjectsPrPlan({
    repositoryRoot,
    packId,
    title: state.title,
    baseBranch: state.baseBranch,
    remote: state.remote,
    verificationCommand: state.verificationCommand
  });
  if (plan.branch !== state.branch
    || !samePath(plan.worktreePath, state.worktreePath)
    || plan.verificationCommandSha256 !== state.verificationCommandSha256
    || !state.baseCommit
    || state.github?.repositorySpecifier !== `${state.github?.host}/${state.github?.nameWithOwner}`) {
    throw new ProjectsPrError('projects-pr state failed its integrity checks.', { code: 'invalid_state' });
  }
  return state;
}

function publicState(statePath, state) {
  return {
    path: statePath ?? null,
    phase: state?.phase ?? null,
    schemaVersion: state?.schemaVersion ?? PROJECTS_PR_STATE_SCHEMA_VERSION
  };
}

function planReceipt(plan) {
  return {
    branch: plan.branch,
    worktreePath: plan.worktreePath,
    verificationCommandSha256: plan.verificationCommandSha256
  };
}

function lifecycleReceipt(command, plan, doctor, statePath, state, status, result = {}) {
  return {
    schemaVersion: PROJECTS_PR_SCHEMA_VERSION,
    kind: 'projects-pr',
    command,
    status,
    packId: plan.packId,
    constraints: { ...PROJECTS_PR_CONSTRAINTS },
    repository: {
      root: plan.repositoryRoot,
      baseBranch: plan.baseBranch,
      remote: plan.remote,
      github: doctor?.repository?.github ?? {
        host: state.github.host,
        nameWithOwner: state.github.nameWithOwner
      }
    },
    plan: planReceipt(plan),
    state: publicState(statePath, state),
    result
  };
}

function recoveryFor(command, plan, state, errorCode) {
  let nextCommand = 'status';
  if (command === 'prepare') nextCommand = state?.phase === 'preparing' ? 'status' : (state ? 'abort' : 'doctor');
  if (command === 'prepare' && errorCode === 'state_exists') nextCommand = 'status';
  if (command === 'finalize' && ['pushed', 'pr_created'].includes(state?.phase)) nextCommand = 'finalize';
  if (command === 'finalize' && [
    'command_failed',
    'github_pr_observation_failed',
    'invalid_gh_receipt',
    'push_verification_failed'
  ].includes(errorCode)) nextCommand = 'finalize';
  const args = nextCommand === 'doctor'
    ? ['--repo', plan.repositoryRoot, '--base', plan.baseBranch, '--remote', plan.remote]
    : ['--pack-id', plan.packId, '--repo', plan.repositoryRoot];
  return { nextCommand, args };
}

function assertDoctorMatchesState(doctor, state) {
  const github = doctor.repository.github;
  if (!github
    || github.host !== state.github.host
    || github.nameWithOwner.toLowerCase() !== state.github.nameWithOwner.toLowerCase()) {
    throw new ProjectsPrError('The recorded GitHub repository no longer matches the declared remote.', {
      code: 'repository_binding_mismatch'
    });
  }
}

function failure(error, command, plan, doctor, statePath, state, result = {}) {
  const projectsError = error instanceof ProjectsPrError
    ? error
    : new ProjectsPrError('projects-pr lifecycle command failed.');
  projectsError.receipt = {
    ...lifecycleReceipt(command, plan, doctor, statePath, state, 'failed', result),
    error: { code: projectsError.code, message: projectsError.message, exitCode: projectsError.exitCode },
    recovery: recoveryFor(command, plan, state, projectsError.code)
  };
  return projectsError;
}

function unavailableError(command, plan, doctor) {
  const error = new ProjectsPrError('PR capability is unavailable; inspect the doctor checks before delegation.', {
    code: 'capability_unavailable'
  });
  error.receipt = {
    schemaVersion: PROJECTS_PR_SCHEMA_VERSION,
    kind: 'projects-pr',
    command,
    status: 'failed',
    packId: plan?.packId ?? null,
    constraints: { ...PROJECTS_PR_CONSTRAINTS },
    repository: doctor.repository,
    capability: doctor.capability,
    error: { code: error.code, message: error.message, exitCode: null },
    recovery: {
      nextCommand: 'doctor',
      args: ['--repo', plan.repositoryRoot, '--base', plan.baseBranch, '--remote', plan.remote]
    }
  };
  return error;
}

async function assertUnoccupiedPlan(plan, doctor, runner, fsApi) {
  const statePath = statePathFor(doctor, plan.packId);
  if (await pathExists(fsApi, statePath)) {
    throw new ProjectsPrError(`State already exists for ${plan.packId}; use status or finalize.`, {
      code: 'state_exists'
    });
  }
  const local = await git(runner, plan.repositoryRoot, ['for-each-ref', '--format=%(objectname)', `refs/heads/${plan.branch}`], 'Local branch check');
  if (local.stdout.trim()) {
    throw new ProjectsPrError(`Dedicated branch already exists: ${plan.branch}.`, { code: 'branch_exists' });
  }
  const worktrees = await git(runner, plan.repositoryRoot, ['worktree', 'list', '--porcelain'], 'Worktree check');
  const registered = worktrees.stdout.split(/\r?\n/gu)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => samePath(line.slice('worktree '.length), plan.worktreePath));
  if (registered || await pathExists(fsApi, plan.worktreePath)) {
    throw new ProjectsPrError(`Derived worktree is occupied: ${plan.worktreePath}.`, { code: 'worktree_exists' });
  }
  const remote = await git(runner, plan.repositoryRoot, ['ls-remote', '--heads', plan.remote, `refs/heads/${plan.branch}`], 'Remote branch check');
  if (remote.stdout.trim()) {
    throw new ProjectsPrError(`Remote branch already exists: ${plan.remote}/${plan.branch}.`, {
      code: 'remote_branch_exists'
    });
  }
  return statePath;
}

export async function prepareProjectsPr(input = {}, dependencies = {}) {
  const runner = dependencies.runner ?? defaultProjectsPrRunner;
  const fsApi = dependencies.fs ?? fs;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const plan = createProjectsPrPlan(input);
  const doctor = await runProjectsPrDoctor(plan, dependencies);
  if (!doctor.capability.available) throw unavailableError('prepare', plan, doctor);
  let statePath;
  let state;
  try {
    statePath = await assertUnoccupiedPlan(plan, doctor, runner, fsApi);
    const baseCommit = (await git(runner, plan.repositoryRoot, ['rev-parse', `refs/heads/${plan.baseBranch}`], 'Base commit resolution')).stdout.trim();
    state = {
      schemaVersion: PROJECTS_PR_STATE_SCHEMA_VERSION,
      kind: STATE_KIND,
      packId: plan.packId,
      title: plan.title,
      repositoryRoot: plan.repositoryRoot,
      baseBranch: plan.baseBranch,
      baseCommit,
      remote: plan.remote,
      github: {
        ...doctor.repository.github,
        repositorySpecifier: `${doctor.repository.github.host}/${doctor.repository.github.nameWithOwner}`
      },
      branch: plan.branch,
      worktreePath: plan.worktreePath,
      verificationCommand: plan.verificationCommand,
      verificationCommandSha256: plan.verificationCommandSha256,
      phase: 'preparing',
      createdAt: now(),
      updatedAt: now(),
      verifiedCommit: null,
      pushedCommit: null,
      draftPullRequest: null
    };
    await writeState(fsApi, statePath, state);
    await fsApi.mkdir(path.dirname(plan.worktreePath), { recursive: true });
    await git(runner, plan.repositoryRoot, ['worktree', 'add', '-b', plan.branch, plan.worktreePath, baseCommit], 'Worktree creation');
    state = { ...state, phase: 'prepared', updatedAt: now() };
    await writeState(fsApi, statePath, state);
    return lifecycleReceipt('prepare', plan, doctor, statePath, state, 'prepared', {
      mutatingCommandsExecuted: true,
      worktreeCreated: true,
      baseCommit
    });
  } catch (error) {
    throw failure(error, 'prepare', plan, doctor, statePath, state, {
      mutatingCommandsExecuted: Boolean(state),
      worktreeCreated: await pathExists(fsApi, plan.worktreePath),
      preservedForDiagnosis: Boolean(state)
    });
  }
}

function parseOidLine(value) {
  const line = String(value ?? '').trim().split(/\s+/u)[0];
  return /^[0-9a-f]{40,64}$/iu.test(line) ? line.toLowerCase() : null;
}

function parseGitHubPullUrl(value, state) {
  let parsed;
  try {
    parsed = new URL(normalizedText(value, 'pull request URL', 1000));
  } catch {
    throw new ProjectsPrError('The pull request URL is invalid.', { code: 'pull_request_mismatch' });
  }
  const expectedRepository = state.github.nameWithOwner.toLowerCase();
  const segments = parsed.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  const actualRepository = segments.slice(0, 2).join('/').toLowerCase();
  const number = Number(segments[3]);
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hostname.toLowerCase() !== state.github.host.toLowerCase()
    || parsed.search
    || parsed.hash
    || segments.length !== 4
    || actualRepository !== expectedRepository
    || segments[2] !== 'pull'
    || !Number.isSafeInteger(number)
    || number < 1
    || String(number) !== segments[3]) {
    throw new ProjectsPrError('The pull request URL does not match the recorded GitHub repository.', {
      code: 'pull_request_mismatch'
    });
  }
  return number;
}

function validatePr(pr, state, headOid, expectedNumber) {
  const expectedOid = parseOidLine(headOid);
  const observedOid = parseOidLine(pr?.head?.sha);
  const expectedRepository = state.github.nameWithOwner.toLowerCase();
  const baseRepository = String(pr?.base?.repo?.full_name ?? '').toLowerCase();
  const headRepository = String(pr?.head?.repo?.full_name ?? '').toLowerCase();
  let urlNumber = null;
  try {
    urlNumber = parseGitHubPullUrl(pr?.html_url, state);
  } catch {
    // Collapse every identity mismatch to one bounded public error below.
  }
  if (!pr
    || !expectedOid
    || !observedOid
    || observedOid !== expectedOid
    || !Number.isSafeInteger(pr.number)
    || pr.number !== expectedNumber
    || urlNumber !== expectedNumber
    || pr.draft !== true
    || String(pr.state).toLowerCase() !== 'open'
    || pr.base?.ref !== state.baseBranch
    || pr.head?.ref !== state.branch
    || baseRepository !== expectedRepository
    || headRepository !== expectedRepository) {
    throw new ProjectsPrError('The observed pull request is not the expected open draft for this exact head.', {
      code: 'pull_request_mismatch'
    });
  }
  return {
    number: pr.number,
    url: pr.html_url,
    draft: true,
    state: 'OPEN',
    base: pr.base.ref,
    head: pr.head.ref,
    headOid: observedOid,
    repository: state.github.nameWithOwner
  };
}

async function verifyPullRequest(runner, state, identity, headOid, label) {
  const urlNumber = parseGitHubPullUrl(identity?.url, state);
  if (identity?.number !== undefined && identity.number !== urlNumber) {
    throw new ProjectsPrError('The pull request number and URL do not match.', {
      code: 'pull_request_mismatch'
    });
  }
  const result = await checked(runner, 'gh', [
    'api', '--hostname', state.github.host,
    `repos/${state.github.nameWithOwner}/pulls/${urlNumber}`
  ], state.repositoryRoot, label);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ProjectsPrError('GitHub CLI returned invalid pull request JSON.', { code: 'invalid_gh_receipt' });
  }
  return validatePr(parsed, state, headOid, urlNumber);
}

async function observeState(state, runner, fsApi) {
  const local = await git(runner, state.repositoryRoot, ['for-each-ref', '--format=%(objectname)', `refs/heads/${state.branch}`], 'Local branch observation');
  const localOid = local.stdout.trim() ? parseOidLine(local.stdout) : null;
  const worktrees = await git(runner, state.repositoryRoot, ['worktree', 'list', '--porcelain'], 'Worktree observation');
  const registered = worktrees.stdout.split(/\r?\n/gu)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => samePath(line.slice('worktree '.length), state.worktreePath));
  const worktreePathExists = await pathExists(fsApi, state.worktreePath);
  let worktreeClean = null;
  let worktreeHeadOid = null;
  if (registered && worktreePathExists) {
    const status = await git(runner, state.repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=normal'], 'Worktree observation', state.worktreePath);
    worktreeClean = !status.stdout.trim();
    worktreeHeadOid = parseOidLine((await git(runner, state.repositoryRoot, ['rev-parse', 'HEAD'], 'Worktree head observation', state.worktreePath)).stdout);
  }
  const remote = await invoke(runner, 'git', ['ls-remote', '--heads', state.remote, `refs/heads/${state.branch}`], state.repositoryRoot);
  const remoteReachable = remote.exitCode === 0;
  const remoteOid = remoteReachable ? parseOidLine(remote.stdout) : null;
  const prResult = await invoke(runner, 'gh', [
    'pr', 'list', '--repo', state.github.repositorySpecifier,
    '--head', state.branch, '--state', 'all',
    '--json', 'number,url'
  ], state.repositoryRoot);
  let pulls = null;
  if (prResult.exitCode === 0) {
    try {
      pulls = JSON.parse(prResult.stdout);
      if (!Array.isArray(pulls)) pulls = null;
    } catch {
      pulls = null;
    }
  }
  return {
    localBranch: { exists: Boolean(localOid), oid: localOid },
    worktree: { registered, pathExists: worktreePathExists, clean: worktreeClean, headOid: worktreeHeadOid },
    remoteBranch: { reachable: remoteReachable, exists: Boolean(remoteOid), oid: remoteOid },
    githubQuery: { available: pulls !== null },
    draftPullRequest: pulls?.length === 1 ? pulls[0] : null,
    pullRequestCount: pulls?.length ?? null
  };
}

async function loadLifecycle(input, dependencies) {
  const runner = dependencies.runner ?? defaultProjectsPrRunner;
  const fsApi = dependencies.fs ?? fs;
  const repositoryRoot = path.resolve(normalizedText(input.repositoryRoot ?? process.cwd(), 'repositoryRoot', 1000));
  const packId = safePackId(input.packId);
  const top = await git(runner, repositoryRoot, ['rev-parse', '--show-toplevel'], 'Repository discovery');
  if (!samePath(top.stdout.trim(), repositoryRoot)) {
    throw new ProjectsPrError('repositoryRoot must be the Git top level.', { code: 'unsafe_repository' });
  }
  const common = await git(runner, repositoryRoot, ['rev-parse', '--git-common-dir'], 'Git common directory discovery');
  const gitCommonDir = path.resolve(repositoryRoot, common.stdout.trim());
  const statePath = path.join(gitCommonDir, 'projects-pr-v2', `${packId}.json`);
  const state = await readState(fsApi, statePath, repositoryRoot, packId);
  const plan = createProjectsPrPlan({
    repositoryRoot,
    packId,
    title: state.title,
    baseBranch: state.baseBranch,
    remote: state.remote,
    verificationCommand: state.verificationCommand
  });
  return { runner, fsApi, statePath, state, plan };
}

export async function statusProjectsPr(input = {}, dependencies = {}) {
  const loaded = await loadLifecycle(input, dependencies);
  try {
    const observed = await observeState(loaded.state, loaded.runner, loaded.fsApi);
    return lifecycleReceipt('status', loaded.plan, null, loaded.statePath, loaded.state, 'observed', {
      observed,
      delivery: loaded.state.delivery ?? { phase: 'manual', authorization: null, merged: null, cleanup: null }
    });
  } catch (error) {
    throw failure(error, 'status', loaded.plan, null, loaded.statePath, loaded.state);
  }
}

function stackRecoveryArgs({ repositoryRoot, baseBranch, remote, packIds }) {
  return [
    ...packIds.flatMap((packId) => ['--pack-id', packId]),
    '--base', baseBranch,
    '--repo', repositoryRoot,
    '--remote', remote
  ];
}

function stackReceipt({ status, repositoryRoot, baseBranch, remote, github, packIds, layers, result = {}, error = null }) {
  const receipt = {
    schemaVersion: PROJECTS_PR_SCHEMA_VERSION,
    kind: 'projects-pr',
    command: 'stack',
    status,
    constraints: {
      draftOnly: true,
      order: 'bottom-to-top',
      minimumLayers: 2,
      merge: 'never'
    },
    repository: { root: repositoryRoot, baseBranch, remote, github },
    packIds,
    layers,
    result
  };
  if (error) receipt.error = error;
  return receipt;
}

function validateStackLayer(pr, state, expectedBase) {
  const headOid = parseOidLine(pr?.headRefOid);
  if (!pr
    || pr.isDraft !== true
    || String(pr.state).toUpperCase() !== 'OPEN'
    || pr.headRefName !== state.branch
    || pr.baseRefName !== expectedBase
    || headOid !== parseOidLine(state.verifiedCommit)
    || !Number.isSafeInteger(pr.number)
    || pr.number < 1) {
    throw new ProjectsPrError(`Stack verification failed for ${state.packId}.`, {
      code: 'stack_verification_failed'
    });
  }
  const number = parseGitHubPullUrl(pr.url, state);
  if (number !== pr.number) {
    throw new ProjectsPrError(`Stack pull request identity failed for ${state.packId}.`, {
      code: 'stack_verification_failed'
    });
  }
  return {
    packId: state.packId,
    branch: state.branch,
    base: expectedBase,
    headOid,
    pullRequest: { number, url: pr.url, draft: true, state: 'OPEN' }
  };
}

async function observeStackLayer(runner, state, expectedBase) {
  const observed = await checked(runner, 'gh', [
    'pr', 'view', state.branch,
    '--repo', state.github.repositorySpecifier,
    '--json', 'number,url,isDraft,state,baseRefName,headRefName,headRefOid'
  ], state.repositoryRoot, `Stack pull request verification for ${state.packId}`);
  let parsed;
  try {
    parsed = JSON.parse(observed.stdout);
  } catch {
    throw new ProjectsPrError('GitHub CLI returned invalid stack pull request JSON.', {
      code: 'invalid_gh_receipt'
    });
  }
  return validateStackLayer(parsed, state, expectedBase);
}

async function verifyDraftLayerBeforeLink(runner, state, allowedBases) {
  const observed = await checked(runner, 'gh', [
    'pr', 'view', state.branch,
    '--repo', state.github.repositorySpecifier,
    '--json', 'number,url,isDraft,state,baseRefName,headRefName,headRefOid'
  ], state.repositoryRoot, `Draft verification for ${state.packId}`);
  let pr;
  try {
    pr = JSON.parse(observed.stdout);
  } catch {
    throw new ProjectsPrError('GitHub CLI returned invalid draft pull request JSON.', {
      code: 'invalid_gh_receipt'
    });
  }
  const urlNumber = parseGitHubPullUrl(pr?.url, state);
  if (pr?.isDraft !== true
    || String(pr?.state).toUpperCase() !== 'OPEN'
    || pr?.headRefName !== state.branch
    || parseOidLine(pr?.headRefOid) !== parseOidLine(state.verifiedCommit)
    || !allowedBases.includes(pr?.baseRefName)
    || pr?.number !== urlNumber) {
    throw new ProjectsPrError(`Draft pull request is not safe to link for ${state.packId}.`, {
      code: 'stack_layer_not_ready'
    });
  }
}

export async function stackProjectsPr(input = {}, dependencies = {}) {
  const runner = dependencies.runner ?? defaultProjectsPrRunner;
  const repositoryRoot = path.resolve(normalizedText(input.repositoryRoot ?? process.cwd(), 'repositoryRoot', 1000));
  const baseBranch = safeGitName(input.baseBranch, 'baseBranch');
  const remote = safeGitName(input.remote ?? 'origin', 'remote');
  const packIds = Array.isArray(input.packIds) ? input.packIds.map(safePackId) : [];
  if (packIds.length < 2 || new Set(packIds).size !== packIds.length) {
    throw new ProjectsPrError('stack requires at least two unique --pack-id values in bottom-to-top order.', {
      code: 'invalid_input'
    });
  }
  const doctor = await runProjectsPrDoctor({ repositoryRoot, baseBranch, remote, stack: true }, dependencies);
  if (!doctor.capability.available) {
    const error = new ProjectsPrError('Stack capability is unavailable; inspect doctor --stack before mutation.', {
      code: 'capability_unavailable'
    });
    error.receipt = {
      ...stackReceipt({
        status: 'failed', repositoryRoot, baseBranch, remote,
        github: doctor.repository.github, packIds, layers: [],
        result: { linked: false, partialRemoteMutationPossible: false }
      }),
      capability: doctor.capability,
      error: { code: error.code, message: error.message, exitCode: null },
      recovery: { nextCommand: 'doctor', args: ['--repo', repositoryRoot, '--base', baseBranch, '--remote', remote, '--stack'] }
    };
    throw error;
  }

  const states = [];
  try {
    for (const packId of packIds) {
      const loaded = await loadLifecycle({ repositoryRoot, packId }, dependencies);
      const state = loaded.state;
      if (state.phase !== 'completed'
        || state.baseBranch !== baseBranch
        || state.remote !== remote
        || state.github.host !== doctor.repository.github.host
        || state.github.nameWithOwner.toLowerCase() !== doctor.repository.github.nameWithOwner.toLowerCase()
        || !state.verifiedCommit
        || !state.draftPullRequest?.url) {
        throw new ProjectsPrError(`Completed draft state is required for stack layer ${packId}.`, {
          code: 'stack_layer_not_ready'
        });
      }
      const remoteHead = await git(
        runner,
        repositoryRoot,
        ['ls-remote', '--heads', remote, `refs/heads/${state.branch}`],
        `Remote stack layer verification for ${packId}`
      );
      if (parseOidLine(remoteHead.stdout) !== parseOidLine(state.verifiedCommit)) {
        throw new ProjectsPrError(`Remote branch no longer matches verified layer ${packId}.`, {
          code: 'stack_layer_not_ready'
        });
      }
      const desiredBase = states.length === 0 ? baseBranch : states.at(-1).branch;
      await verifyDraftLayerBeforeLink(runner, state, [...new Set([baseBranch, desiredBase])]);
      states.push(state);
    }

    const branches = states.map((state) => state.branch);
    await checked(runner, 'gh', [
      'stack', 'link', '--base', baseBranch, '--remote', remote, ...branches
    ], repositoryRoot, 'GitHub stack link');

    const layers = [];
    for (let index = 0; index < states.length; index += 1) {
      layers.push(await observeStackLayer(
        runner,
        states[index],
        index === 0 ? baseBranch : states[index - 1].branch
      ));
    }
    return stackReceipt({
      status: 'completed',
      repositoryRoot,
      baseBranch,
      remote,
      github: doctor.repository.github,
      packIds,
      layers,
      result: {
        linked: true,
        officialExtension: 'github/gh-stack',
        command: ['gh', 'stack', 'link', '--base', baseBranch, '--remote', remote, ...branches],
        draftPullRequestsPreserved: true,
        ownerReviewRequired: true,
        mergeRequested: false
      }
    });
  } catch (error) {
    const projectsError = error instanceof ProjectsPrError
      ? error
      : new ProjectsPrError('projects-pr stack failed.', { code: 'stack_failed' });
    projectsError.receipt = {
      ...stackReceipt({
        status: 'failed', repositoryRoot, baseBranch, remote,
        github: doctor.repository.github, packIds,
        layers: states.map((state) => ({ packId: state.packId, branch: state.branch })),
        result: {
          linked: false,
          partialRemoteMutationPossible: true,
          note: 'GitHub stack link is not atomic; rerun the same ordered command after inspecting the remote stack.'
        },
        error: { code: projectsError.code, message: projectsError.message, exitCode: projectsError.exitCode }
      }),
      recovery: {
        nextCommand: 'stack',
        args: stackRecoveryArgs({ repositoryRoot, baseBranch, remote, packIds })
      }
    };
    throw projectsError;
  }
}

export function createProjectsPrOwnerDecision({ draftPullRequest, pushedRefspec, verificationCommandSha256 } = {}) {
  if (!draftPullRequest || draftPullRequest.draft !== true || !draftPullRequest.url) return null;
  return {
    state: PROJECTS_PR_OWNER_DECISION.state,
    recommendation: PROJECTS_PR_OWNER_DECISION.recommendation,
    pullRequestUrl: draftPullRequest.url,
    evidence: { verificationCommandSha256, pushedRefspec, draft: true },
    merge: { ...PROJECTS_PR_OWNER_DECISION.merge }
  };
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectsPrError(`${label} must be an object.`, { code: 'invalid_delivery_policy' });
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ProjectsPrError(`${label} contains unknown field: ${unknown[0]}.`, {
      code: 'invalid_delivery_policy'
    });
  }
  return value;
}

function safeOid(value, label) {
  const oid = normalizedText(value, label, 64).toLowerCase();
  if (!SAFE_OID.test(oid)) {
    throw new ProjectsPrError(`${label} must be a full Git object ID.`, { code: 'invalid_input' });
  }
  return oid;
}

function configuredBoolean(value, label) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ProjectsPrError(`${label} must be boolean.`, { code: 'invalid_delivery_policy' });
  }
  return value === true;
}

function validateRequiredCheck(raw, index) {
  const label = `reviewedMerge.requiredChecks[${index}]`;
  const check = exactKeys(raw, ['kind', 'name', 'publisherId'], label);
  const kind = normalizedText(check.kind, `${label}.kind`, 40);
  if (!['check-run', 'status-context'].includes(kind)) {
    throw new ProjectsPrError(`${label}.kind must be check-run or status-context.`, {
      code: 'invalid_delivery_policy'
    });
  }
  const name = normalizedText(check.name, `${label}.name`, 200);
  if (!Number.isSafeInteger(check.publisherId) || check.publisherId < 1) {
    throw new ProjectsPrError(`${label}.publisherId must be a positive integer.`, {
      code: 'invalid_delivery_policy'
    });
  }
  return { kind, name, publisherId: check.publisherId };
}

function defaultDeliveryPolicy(state, baseOid) {
  return {
    schemaVersion: DELIVERY_POLICY_SCHEMA_VERSION,
    repository: state.github.repositorySpecifier,
    source: { path: DELIVERY_POLICY_PATH, baseOid, present: false, sha256: null },
    reviewedMerge: { enabled: false, method: null, requiredChecks: [] },
    remoteBranchCleanup: { enabled: false, protectedBranches: [] },
    adminOverride: { enabled: false }
  };
}

function parseDeliveryPolicy(text, state, baseOid) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectsPrError('The trusted delivery policy is invalid JSON.', {
      code: 'invalid_delivery_policy'
    });
  }
  exactKeys(raw, [
    'schemaVersion', 'repository', 'reviewedMerge', 'remoteBranchCleanup', 'adminOverride'
  ], 'delivery policy');
  if (raw.schemaVersion !== DELIVERY_POLICY_SCHEMA_VERSION) {
    throw new ProjectsPrError('The trusted delivery policy schema version is unsupported.', {
      code: 'invalid_delivery_policy'
    });
  }
  const repository = normalizedText(raw.repository, 'delivery policy repository', 300).toLowerCase();
  if (repository !== state.github.repositorySpecifier.toLowerCase()) {
    throw new ProjectsPrError('The trusted delivery policy repository binding does not match.', {
      code: 'delivery_policy_repository_mismatch'
    });
  }

  const mergeRaw = raw.reviewedMerge === undefined
    ? {}
    : exactKeys(raw.reviewedMerge, ['enabled', 'method', 'requiredChecks'], 'reviewedMerge');
  const mergeEnabled = configuredBoolean(mergeRaw.enabled, 'reviewedMerge.enabled');
  let method = null;
  let requiredChecks = [];
  if (mergeRaw.method !== undefined) {
    method = normalizedText(mergeRaw.method, 'reviewedMerge.method', 20);
    if (!MERGE_METHODS.has(method)) {
      throw new ProjectsPrError('reviewedMerge.method must be merge, squash, or rebase.', {
        code: 'invalid_delivery_policy'
      });
    }
  }
  if (mergeRaw.requiredChecks !== undefined) {
    if (!Array.isArray(mergeRaw.requiredChecks) || mergeRaw.requiredChecks.length === 0) {
      throw new ProjectsPrError('reviewedMerge.requiredChecks must be a nonempty list when supplied.', {
        code: 'invalid_delivery_policy'
      });
    }
    requiredChecks = mergeRaw.requiredChecks.map(validateRequiredCheck);
    const identities = requiredChecks.map((item) => `${item.kind}:${item.publisherId}:${item.name}`);
    if (new Set(identities).size !== identities.length) {
      throw new ProjectsPrError('reviewedMerge.requiredChecks contains a duplicate identity.', {
        code: 'invalid_delivery_policy'
      });
    }
  }
  if (mergeEnabled && (!method || requiredChecks.length === 0)) {
    throw new ProjectsPrError('Enabled reviewedMerge requires a method and nonempty requiredChecks list.', {
      code: 'invalid_delivery_policy'
    });
  }

  const cleanupRaw = raw.remoteBranchCleanup === undefined
    ? {}
    : exactKeys(raw.remoteBranchCleanup, ['enabled', 'protectedBranches'], 'remoteBranchCleanup');
  if (!Array.isArray(cleanupRaw.protectedBranches ?? [])) {
    throw new ProjectsPrError('remoteBranchCleanup.protectedBranches must be an array.', {
      code: 'invalid_delivery_policy'
    });
  }
  const cleanupEnabled = configuredBoolean(cleanupRaw.enabled, 'remoteBranchCleanup.enabled');
  const protectedBranches = cleanupRaw.protectedBranches === undefined
    ? []
    : cleanupRaw.protectedBranches.map((branch, index) => safeGitName(branch, `protectedBranches[${index}]`));
  if (new Set(protectedBranches).size !== protectedBranches.length) {
    throw new ProjectsPrError('remoteBranchCleanup.protectedBranches contains a duplicate.', {
      code: 'invalid_delivery_policy'
    });
  }

  const adminRaw = raw.adminOverride === undefined
    ? {}
    : exactKeys(raw.adminOverride, ['enabled'], 'adminOverride');
  const adminEnabled = configuredBoolean(adminRaw.enabled, 'adminOverride.enabled');

  return {
    schemaVersion: DELIVERY_POLICY_SCHEMA_VERSION,
    repository: state.github.repositorySpecifier,
    source: { path: DELIVERY_POLICY_PATH, baseOid, present: true, sha256: sha256(text) },
    reviewedMerge: { enabled: mergeEnabled, method, requiredChecks },
    remoteBranchCleanup: { enabled: cleanupEnabled, protectedBranches },
    adminOverride: { enabled: adminEnabled }
  };
}

const DELIVERY_POLICY_QUERY = [
  'query($owner:String!,$name:String!,$expression:String!){',
  'repository(owner:$owner,name:$name){',
  'object(expression:$expression){... on Blob{text oid byteSize}}',
  '}}'
].join('');

const CLASSIC_PROTECTION_QUERY = [
  'query($owner:String!,$name:String!,$qualifiedName:String!){',
  'repository(owner:$owner,name:$name){viewerPermission ',
  'ref(qualifiedName:$qualifiedName){name branchProtectionRule{id pattern}}',
  '}}'
].join('');

async function readDeliveryPolicy(runner, state, baseOid) {
  const [owner, name] = state.github.nameWithOwner.split('/');
  const result = await invokeBounded(runner, 'gh', [
    'api', 'graphql', '--hostname', state.github.host,
    '-f', `query=${DELIVERY_POLICY_QUERY}`,
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `expression=${baseOid}:${DELIVERY_POLICY_PATH}`
  ], state.repositoryRoot);
  if (result.exitCode !== 0) {
    throw new ProjectsPrError('The trusted delivery policy could not be observed.', {
      code: 'delivery_policy_observation_failed', exitCode: result.exitCode
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ProjectsPrError('GitHub returned invalid policy JSON.', { code: 'invalid_gh_receipt' });
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    throw new ProjectsPrError('The trusted delivery policy could not be observed.', {
      code: 'delivery_policy_observation_failed'
    });
  }
  const repository = parsed?.data?.repository;
  if (!repository) {
    throw new ProjectsPrError('The policy repository could not be observed.', {
      code: 'delivery_policy_observation_failed'
    });
  }
  const blob = repository.object;
  if (blob === null) return defaultDeliveryPolicy(state, baseOid);
  if (typeof blob?.text !== 'string' || !Number.isSafeInteger(blob.byteSize) || blob.byteSize > 32_768) {
    throw new ProjectsPrError('The trusted delivery policy must be a text file no larger than 32 KiB.', {
      code: 'invalid_delivery_policy'
    });
  }
  return parseDeliveryPolicy(blob.text, state, baseOid);
}

async function githubJson(runner, state, args, label) {
  const result = await invokeBounded(runner, 'gh', [
    'api', '--hostname', state.github.host, ...args
  ], state.repositoryRoot);
  if (result.exitCode !== 0) {
    throw new ProjectsPrError(`${label} failed.`, {
      code: 'github_delivery_observation_failed', exitCode: result.exitCode
    });
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ProjectsPrError(`${label} returned invalid JSON.`, { code: 'invalid_gh_receipt' });
  }
}

function validateDeliveryPullRequest(raw, state) {
  const number = state.draftPullRequest?.number;
  const expectedRepository = state.github.nameWithOwner.toLowerCase();
  const urlNumber = parseGitHubPullUrl(raw?.html_url, state);
  const headOid = parseOidLine(raw?.head?.sha);
  const baseOid = parseOidLine(raw?.base?.sha);
  const mergeCommitOid = raw?.merge_commit_sha ? parseOidLine(raw.merge_commit_sha) : null;
  if (!Number.isSafeInteger(number)
    || raw?.number !== number
    || urlNumber !== number
    || raw?.head?.ref !== state.branch
    || raw?.base?.ref !== state.baseBranch
    || String(raw?.head?.repo?.full_name ?? '').toLowerCase() !== expectedRepository
    || String(raw?.base?.repo?.full_name ?? '').toLowerCase() !== expectedRepository
    || !headOid
    || !baseOid
    || headOid !== state.verifiedCommit
    || headOid !== state.pushedCommit) {
    throw new ProjectsPrError('The pull request no longer matches the finalized repository, base, branch, and head.', {
      code: 'delivery_identity_mismatch'
    });
  }
  return {
    number,
    url: raw.html_url,
    state: String(raw.state).toUpperCase(),
    draft: raw.draft === true,
    merged: raw.merged === true,
    mergedAt: typeof raw.merged_at === 'string' ? raw.merged_at : null,
    mergeCommitOid,
    mergeable: typeof raw.mergeable === 'boolean' ? raw.mergeable : null,
    mergeableState: typeof raw.mergeable_state === 'string' ? raw.mergeable_state.toLowerCase() : null,
    base: raw.base.ref,
    baseOid,
    head: raw.head.ref,
    headOid,
    repository: state.github.nameWithOwner
  };
}

async function observeDeliveryPullRequest(runner, state) {
  const raw = await githubJson(runner, state, [
    `repos/${state.github.nameWithOwner}/pulls/${state.draftPullRequest?.number}`
  ], 'Exact pull request observation');
  return validateDeliveryPullRequest(raw, state);
}

function assertDeliveryRepositoryAllowed(state) {
  if (FROZEN_REPOSITORIES.has(state.github.repositorySpecifier.toLowerCase())) {
    throw new ProjectsPrError('Delivery mutations are frozen for this repository.', {
      code: 'frozen_repository'
    });
  }
}

async function listOpenPullRequests(runner, state) {
  const pages = await githubJson(runner, state, [
    '--paginate', '--slurp',
    `repos/${state.github.nameWithOwner}/pulls?state=open&per_page=100`
  ], 'Open pull request observation');
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new ProjectsPrError('GitHub returned an invalid open pull request list.', {
      code: 'invalid_gh_receipt'
    });
  }
  return pages.flat();
}

async function assertStandaloneDelivery(runner, state, pullRequest) {
  const pulls = await listOpenPullRequests(runner, state);
  const conflicts = pulls.filter((candidate) => candidate?.number !== pullRequest.number
    && (candidate?.base?.ref === state.branch
      || (candidate?.head?.ref === state.branch
        && String(candidate?.head?.repo?.full_name ?? '').toLowerCase()
          === state.github.nameWithOwner.toLowerCase())));
  if (conflicts.length > 0) {
    throw new ProjectsPrError('Delivery is refused for a stacked, shared, or dependent pull request branch.', {
      code: 'stacked_or_shared_branch'
    });
  }
}

async function observeRequiredChecks(runner, state, authorization, policy) {
  const required = policy.reviewedMerge.requiredChecks;
  const needsRuns = required.some((item) => item.kind === 'check-run');
  const needsStatuses = required.some((item) => item.kind === 'status-context');
  let runs = [];
  let statuses = [];
  if (needsRuns) {
    const response = await githubJson(runner, state, [
      `repos/${state.github.nameWithOwner}/commits/${authorization.pullRequest.headOid}/check-runs?filter=latest&per_page=100`
    ], 'Required check-run observation');
    if (!Number.isSafeInteger(response?.total_count)
      || !Array.isArray(response?.check_runs)
      || response.total_count !== response.check_runs.length
      || response.total_count > 100) {
      throw new ProjectsPrError('The complete required check-run set could not be observed.', {
        code: 'incomplete_check_observation'
      });
    }
    runs = response.check_runs;
  }
  if (needsStatuses) {
    const response = await githubJson(runner, state, [
      `repos/${state.github.nameWithOwner}/commits/${authorization.pullRequest.headOid}/status?per_page=100`
    ], 'Required commit-status observation');
    if (parseOidLine(response?.sha) !== authorization.pullRequest.headOid
      || !Number.isSafeInteger(response?.total_count)
      || !Array.isArray(response?.statuses)
      || response.total_count !== response.statuses.length
      || response.total_count > 100) {
      throw new ProjectsPrError('The complete required commit-status set could not be observed.', {
        code: 'incomplete_check_observation'
      });
    }
    statuses = response.statuses;
  }

  const observations = required.map((checkPolicy) => {
    const matches = checkPolicy.kind === 'check-run'
      ? runs.filter((run) => run?.name === checkPolicy.name && run?.app?.id === checkPolicy.publisherId)
      : statuses.filter((status) => status?.context === checkPolicy.name
        && status?.creator?.id === checkPolicy.publisherId);
    if (matches.length !== 1) {
      return {
        ...checkPolicy,
        outcome: matches.length === 0 ? 'missing' : 'ambiguous',
        state: null
      };
    }
    const observed = matches[0];
    if (checkPolicy.kind === 'check-run') {
      const exactHead = parseOidLine(observed.head_sha) === authorization.pullRequest.headOid;
      const passed = exactHead && observed.status === 'completed' && observed.conclusion === 'success';
      const outcome = !exactHead
        ? 'stale-sha'
        : (observed.status !== 'completed'
          ? String(observed.status ?? 'unknown')
          : String(observed.conclusion ?? 'unknown'));
      return {
        ...checkPolicy,
        outcome: passed ? 'success' : outcome,
        state: `${String(observed.status ?? 'unknown')}/${String(observed.conclusion ?? 'unknown')}`
      };
    }
    const passed = observed.state === 'success';
    return {
      ...checkPolicy,
      outcome: passed ? 'success' : String(observed.state ?? 'unknown'),
      state: String(observed.state ?? 'unknown')
    };
  });
  return {
    headOid: authorization.pullRequest.headOid,
    passed: observations.every((item) => item.outcome === 'success'),
    required: observations
  };
}

async function observeClassicBranchProtection(runner, state, baseBranch, aggregateProtected) {
  const [owner, name] = state.github.nameWithOwner.split('/');
  const result = await invokeBounded(runner, 'gh', [
    'api', 'graphql', '--hostname', state.github.host,
    '-f', `query=${CLASSIC_PROTECTION_QUERY}`,
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `qualifiedName=refs/heads/${baseBranch}`
  ], state.repositoryRoot);
  if (result.exitCode !== 0) {
    throw new ProjectsPrError('Classic branch protection observation failed.', {
      code: 'admin_requirements_unavailable', exitCode: result.exitCode
    });
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new ProjectsPrError('Classic branch protection observation returned invalid JSON.', {
      code: 'admin_requirements_unavailable'
    });
  }
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new ProjectsPrError('Classic branch protection observation was incomplete.', {
      code: 'admin_requirements_unavailable'
    });
  }
  const repository = response?.data?.repository;
  const ref = repository?.ref;
  if (repository?.viewerPermission !== 'ADMIN'
    || ref?.name !== baseBranch
    || !Object.hasOwn(ref ?? {}, 'branchProtectionRule')) {
    throw new ProjectsPrError('Classic branch protection requires an exact administrator-visible ref observation.', {
      code: 'admin_requirements_unavailable'
    });
  }
  if (ref.branchProtectionRule !== null) {
    if (typeof ref.branchProtectionRule?.id !== 'string'
      || typeof ref.branchProtectionRule?.pattern !== 'string') {
      throw new ProjectsPrError('Classic branch protection observation was malformed.', {
        code: 'admin_requirements_unavailable'
      });
    }
    throw new ProjectsPrError('Admin delivery does not bypass classic branch protection requirements.', {
      code: 'unsupported_admin_requirements'
    });
  }
  const receipt = {
    aggregateProtected,
    viewerPermission: repository.viewerPermission,
    refName: ref.name,
    branchProtectionRule: null
  };
  return { sha256: sha256(canonicalJson(receipt)) };
}

async function observeAdminRequirements(runner, state, authorization, method) {
  const encodedBase = encodeURIComponent(authorization.pullRequest.base);
  const pages = await githubJson(runner, state, [
    '--paginate', '--slurp',
    `repos/${state.github.nameWithOwner}/rules/branches/${encodedBase}?per_page=100`
  ], 'Active repository rules observation');
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new ProjectsPrError('GitHub returned an invalid active rules list.', { code: 'invalid_gh_receipt' });
  }

  const branch = await githubJson(runner, state, [
    `repos/${state.github.nameWithOwner}/branches/${encodedBase}`
  ], 'Base branch protection metadata observation');
  if (typeof branch?.protected !== 'boolean') {
    throw new ProjectsPrError('Base branch protection metadata is incomplete.', {
      code: 'admin_requirements_unavailable'
    });
  }

  const classicProtection = await observeClassicBranchProtection(
    runner, state, authorization.pullRequest.base, branch.protected
  );

  const activeRules = pages.flat();
  const types = [...new Set(activeRules.map((rule) => String(rule?.type ?? '')))].sort();
  if (types.includes('required_status_checks')) {
    throw new ProjectsPrError('Admin delivery never bypasses repository-configured status checks.', {
      code: 'unsupported_admin_requirements'
    });
  }
  if (types.includes('required_linear_history') && method === 'merge') {
    throw new ProjectsPrError('The selected merge method does not satisfy required linear history.', {
      code: 'unsupported_admin_requirements'
    });
  }
  const unsupported = types.filter((type) => type
    && !ADMIN_BYPASS_RULES.has(type)
    && !ADMIN_IRRELEVANT_RULES.has(type)
    && type !== 'required_linear_history');
  if (unsupported.length > 0 || types.includes('')) {
    throw new ProjectsPrError('Admin delivery encountered an unsupported external requirement.', {
      code: 'unsupported_admin_requirements'
    });
  }
  const bypassedRequirements = types.filter((type) => ADMIN_BYPASS_RULES.has(type))
    .map((type) => ADMIN_BYPASS_RULES.get(type)).sort();
  if (bypassedRequirements.length === 0) {
    throw new ProjectsPrError('Admin delivery requires at least one observable supported requirement to bypass.', {
      code: 'admin_override_not_required'
    });
  }
  const canonicalRules = activeRules.map((rule) => canonicalJson(rule)).sort();
  return {
    bypassedRequirements,
    rulesSha256: sha256(JSON.stringify(canonicalRules)),
    classicProtectionSha256: classicProtection.sha256
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deliveryReceipt(command, plan, statePath, state, status, result = {}) {
  return {
    schemaVersion: PROJECTS_PR_SCHEMA_VERSION,
    kind: 'projects-pr-delivery',
    command,
    status,
    packId: plan.packId,
    constraints: {
      onePullRequest: true,
      exactAuthorizedHead: true,
      requiredChecks: true,
      nativeAutoMerge: false,
      localEvidencePreserved: true
    },
    repository: {
      root: plan.repositoryRoot,
      baseBranch: plan.baseBranch,
      remote: plan.remote,
      github: { host: state.github.host, nameWithOwner: state.github.nameWithOwner }
    },
    plan: planReceipt(plan),
    state: {
      ...publicState(statePath, state),
      deliveryPhase: state.delivery?.phase ?? null
    },
    result
  };
}

function deliveryRecovery(command, plan) {
  return {
    nextCommand: command === 'finish' ? 'finish' : 'status',
    args: ['--pack-id', plan.packId, '--repo', plan.repositoryRoot]
  };
}

function deliveryFailure(error, command, plan, statePath, state, result = {}) {
  const projectsError = error instanceof ProjectsPrError
    ? error
    : new ProjectsPrError('projects-pr delivery command failed.');
  projectsError.receipt = {
    ...deliveryReceipt(command, plan, statePath, state, 'failed', result),
    error: { code: projectsError.code, message: projectsError.message, exitCode: projectsError.exitCode },
    recovery: deliveryRecovery(command, plan)
  };
  return projectsError;
}

function assertCompletedForDelivery(state) {
  if (state.phase !== 'completed'
    || !state.draftPullRequest
    || !state.verifiedCommit
    || state.verifiedCommit !== state.pushedCommit) {
    throw new ProjectsPrError('Delivery requires one completed draft-first lifecycle.', {
      code: 'delivery_not_finalized'
    });
  }
}

function normalizedBypasses(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProjectsPrError('Admin authorization requires at least one --bypass value.', {
      code: 'invalid_admin_authorization'
    });
  }
  const values = value.map((item, index) => normalizedText(item, `bypass[${index}]`, 160));
  if (new Set(values).size !== values.length) {
    throw new ProjectsPrError('Admin authorization bypass values must be unique.', {
      code: 'invalid_admin_authorization'
    });
  }
  return values.sort();
}

function authorizationMatchesPullRequest(authorization, pullRequest, { requireBaseOid = true } = {}) {
  return authorization?.pullRequest?.number === pullRequest.number
    && authorization.pullRequest.repository.toLowerCase() === pullRequest.repository.toLowerCase()
    && authorization.pullRequest.base === pullRequest.base
    && (!requireBaseOid || authorization.pullRequest.baseOid === pullRequest.baseOid)
    && authorization.pullRequest.head === pullRequest.head
    && authorization.pullRequest.headOid === pullRequest.headOid;
}

function assertAuthorizationMatchesPullRequest(authorization, pullRequest, options) {
  const same = authorization?.repository?.host
    && authorization?.repository?.nameWithOwner
    && authorization.repository.host.toLowerCase() === authorization.policy.repository.split('/')[0].toLowerCase()
    && authorization.repository.nameWithOwner.toLowerCase() === pullRequest.repository.toLowerCase()
    && authorizationMatchesPullRequest(authorization, pullRequest, options);
  if (!same) {
    throw new ProjectsPrError('The pull request changed after owner authorization.', {
      code: 'stale_delivery_authorization'
    });
  }
}

function assertPolicyMatchesAuthorization(policy, authorization) {
  if (!policy.source.present
    || policy.source.baseOid !== authorization.policy.baseOid
    || policy.source.sha256 !== authorization.policy.sha256
    || policy.repository.toLowerCase() !== authorization.policy.repository.toLowerCase()
    || !policy.reviewedMerge.enabled) {
    throw new ProjectsPrError('The trusted delivery policy no longer matches the authorization.', {
      code: 'stale_delivery_policy'
    });
  }
}

async function authorizeDelivery(input, dependencies, mode) {
  const loaded = await loadLifecycle(input, dependencies);
  const { runner, fsApi, statePath, plan } = loaded;
  const now = dependencies.now ?? (() => new Date().toISOString());
  let state = loaded.state;
  const command = mode === 'admin' ? 'authorize-admin' : 'authorize';
  try {
    assertCompletedForDelivery(state);
    assertDeliveryRepositoryAllowed(state);
    if (input.confirmReview !== true || input.confirmOwner !== true) {
      throw new ProjectsPrError('Authorization requires explicit review and owner confirmations.', {
        code: 'authorization_confirmation_required'
      });
    }
    const reviewedHead = safeOid(input.reviewedHead, 'reviewedHead');
    const pullRequest = await observeDeliveryPullRequest(runner, state);
    if (pullRequest.merged || pullRequest.state !== 'OPEN') {
      throw new ProjectsPrError('Authorization requires the exact open pull request.', {
        code: 'delivery_pull_request_not_open'
      });
    }
    const resumingReadyPull = pullRequest.draft === false
      && state.delivery?.readyAt
      && state.delivery?.authorization?.pullRequest?.headOid === pullRequest.headOid;
    if (!pullRequest.draft && !resumingReadyPull) {
      throw new ProjectsPrError('Authorization starts from the finalized draft pull request.', {
        code: 'delivery_pull_request_not_draft'
      });
    }
    if (reviewedHead !== pullRequest.headOid
      || reviewedHead !== state.verifiedCommit
      || reviewedHead !== state.pushedCommit) {
      throw new ProjectsPrError('The reviewed head is not the exact finalized pull request head.', {
        code: 'stale_reviewed_head'
      });
    }
    await assertStandaloneDelivery(runner, state, pullRequest);
    const policy = await readDeliveryPolicy(runner, state, pullRequest.baseOid);
    if (!policy.reviewedMerge.enabled) {
      throw new ProjectsPrError('Reviewed merge is not enabled by the trusted base policy.', {
        code: 'reviewed_merge_disabled'
      });
    }
    if (mode === 'admin' && !policy.adminOverride.enabled) {
      throw new ProjectsPrError('Admin override is not enabled by the trusted base policy.', {
        code: 'admin_override_disabled'
      });
    }

    let override = null;
    if (mode === 'admin') {
      const reason = normalizedText(input.reason, 'reason', 500);
      const requested = normalizedBypasses(input.bypassedRequirements);
      const observed = await observeAdminRequirements(runner, state, {
        pullRequest
      }, policy.reviewedMerge.method);
      if (JSON.stringify(requested) !== JSON.stringify(observed.bypassedRequirements)) {
        throw new ProjectsPrError('Admin bypass values must exactly match the observable supported requirements.', {
          code: 'admin_bypass_mismatch'
        });
      }
      override = {
        reason,
        bypassedRequirements: requested,
        observedRulesSha256: observed.rulesSha256,
        classicProtectionSha256: observed.classicProtectionSha256
      };
    }

    const authorization = {
      mode,
      authorizedAt: now(),
      repository: { host: state.github.host, nameWithOwner: state.github.nameWithOwner },
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.url,
        repository: pullRequest.repository,
        base: pullRequest.base,
        baseOid: pullRequest.baseOid,
        head: pullRequest.head,
        headOid: pullRequest.headOid
      },
      policy: {
        path: policy.source.path,
        baseOid: policy.source.baseOid,
        sha256: policy.source.sha256,
        repository: policy.repository
      },
      review: {
        accepted: true,
        reviewedHead,
        kind: 'coordinator-attestation',
        independentGitHubApproval: false
      },
      owner: { confirmed: true },
      override
    };
    state = {
      ...state,
      delivery: {
        phase: 'authorized',
        authorization,
        readyAt: resumingReadyPull ? state.delivery.readyAt : null,
        merged: null,
        cleanup: null
      },
      updatedAt: now()
    };
    await writeState(fsApi, statePath, state);
    return deliveryReceipt(command, plan, statePath, state, 'authorized', {
      resumed: false,
      authorization,
      policy: {
        source: policy.source,
        reviewedMerge: policy.reviewedMerge,
        remoteBranchCleanup: policy.remoteBranchCleanup,
        adminOverride: policy.adminOverride
      }
    });
  } catch (error) {
    throw deliveryFailure(error, command, plan, statePath, state);
  }
}

export async function authorizeProjectsPr(input = {}, dependencies = {}) {
  return authorizeDelivery(input, dependencies, 'reviewed');
}

export async function authorizeAdminProjectsPr(input = {}, dependencies = {}) {
  return authorizeDelivery(input, dependencies, 'admin');
}

function parsePushDestination(remoteUrl, state) {
  if (/^(?:https|ssh):\/\//iu.test(remoteUrl)) {
    let parsed;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      throw new ProjectsPrError('The cleanup push destination is invalid.', {
        code: 'cleanup_push_destination_mismatch'
      });
    }
    if (parsed.port) {
      throw new ProjectsPrError('Cleanup refuses a push destination with a custom port.', {
        code: 'cleanup_push_destination_mismatch'
      });
    }
  }
  const parsed = parseGitHubRemote(remoteUrl);
  if (parsed.host !== state.github.host.toLowerCase()
    || parsed.nameWithOwner.toLowerCase() !== state.github.nameWithOwner.toLowerCase()) {
    throw new ProjectsPrError('The cleanup push destination does not match the authorized repository.', {
      code: 'cleanup_push_destination_mismatch'
    });
  }
  return parsed;
}

async function assertCleanupPushDestination(runner, state) {
  const urls = await invokeBounded(runner, 'git', [
    'remote', 'get-url', '--push', '--all', state.remote
  ], state.repositoryRoot);
  const destinations = urls.stdout.split(/\r?\n/gu).map((value) => value.trim()).filter(Boolean);
  if (urls.exitCode !== 0 || destinations.length !== 1) {
    throw new ProjectsPrError('Cleanup requires exactly one observable push destination.', {
      code: 'cleanup_push_destination_mismatch', exitCode: urls.exitCode
    });
  }
  parsePushDestination(destinations[0], state);
  const mirror = await invokeBounded(runner, 'git', [
    'config', '--get-all', `remote.${state.remote}.mirror`
  ], state.repositoryRoot);
  if (![0, 1].includes(mirror.exitCode)) {
    throw new ProjectsPrError('Cleanup could not inspect remote mirror configuration.', {
      code: 'cleanup_push_destination_mismatch', exitCode: mirror.exitCode
    });
  }
  const mirrorValues = mirror.stdout.split(/\r?\n/gu).map((value) => value.trim()).filter(Boolean);
  if (mirrorValues.some((value) => !['false', 'no', 'off', '0'].includes(value.toLowerCase()))) {
    throw new ProjectsPrError('Cleanup refuses a mirror push remote.', {
      code: 'cleanup_push_destination_mismatch'
    });
  }
}

async function cleanupMergedRemoteBranch(runner, state, authorization, policy) {
  const branch = state.branch;
  const expectedOid = authorization.pullRequest.headOid;
  const expectedRef = `refs/heads/${branch}`;
  if (!policy.remoteBranchCleanup.enabled) {
    return { status: 'retained', reason: 'policy-disabled', deletedByController: false };
  }
  if (branch === state.baseBranch || policy.remoteBranchCleanup.protectedBranches.includes(branch)) {
    return { status: 'retained', reason: 'protected-branch', deletedByController: false };
  }
  const repository = await githubJson(runner, state, [
    `repos/${state.github.nameWithOwner}`
  ], 'Repository cleanup guard observation');
  if (repository?.default_branch === branch) {
    return { status: 'retained', reason: 'default-branch', deletedByController: false };
  }
  if (typeof repository?.default_branch !== 'string') {
    throw new ProjectsPrError('The default branch could not be observed for cleanup.', {
      code: 'cleanup_guard_unavailable'
    });
  }
  const pulls = await listOpenPullRequests(runner, state);
  const conflict = pulls.find((pull) => pull?.base?.ref === branch
    || (pull?.head?.ref === branch
      && String(pull?.head?.repo?.full_name ?? '').toLowerCase()
        === state.github.nameWithOwner.toLowerCase()));
  if (conflict) {
    return {
      status: 'waiting',
      reason: pullNumberReason(conflict.number),
      deletedByController: false
    };
  }
  await assertCleanupPushDestination(runner, state);
  const before = await invokeBounded(runner, 'git', [
    'ls-remote', '--heads', state.remote, expectedRef
  ], state.repositoryRoot);
  if (before.exitCode !== 0) {
    throw new ProjectsPrError('The remote branch could not be observed for cleanup.', {
      code: 'cleanup_guard_unavailable', exitCode: before.exitCode
    });
  }
  const beforeOid = parseExactRemoteRef(before.stdout, expectedRef);
  if (!beforeOid) {
    return { status: 'already-absent', reason: null, deletedByController: false };
  }
  if (beforeOid !== expectedOid) {
    throw new ProjectsPrError('Cleanup refused because the remote branch changed or was reused.', {
      code: 'remote_branch_changed'
    });
  }
  const lease = `--force-with-lease=${expectedRef}:${expectedOid}`;
  const deletion = await invokeBounded(runner, 'git', [
    'push', lease, state.remote, `:refs/heads/${branch}`
  ], state.repositoryRoot);
  if (deletion.exitCode !== 0) {
    const raced = await invokeBounded(runner, 'git', [
      'ls-remote', '--heads', state.remote, expectedRef
    ], state.repositoryRoot);
    const racedOid = raced.exitCode === 0 ? parseExactRemoteRef(raced.stdout, expectedRef) : null;
    if (raced.exitCode === 0 && !racedOid) {
      return { status: 'already-absent', reason: 'removed-elsewhere', deletedByController: false };
    }
    if (racedOid && racedOid !== expectedOid) {
      throw new ProjectsPrError('Cleanup lease refused a changed or reused remote branch.', {
        code: 'remote_branch_changed', exitCode: deletion.exitCode
      });
    }
    throw new ProjectsPrError('The leased remote branch deletion failed.', {
      code: 'cleanup_delete_failed', exitCode: deletion.exitCode
    });
  }
  const after = await invokeBounded(runner, 'git', [
    'ls-remote', '--heads', state.remote, expectedRef
  ], state.repositoryRoot);
  if (after.exitCode !== 0 || parseExactRemoteRef(after.stdout, expectedRef)) {
    throw new ProjectsPrError('Remote branch deletion could not be verified.', {
      code: 'cleanup_verification_failed', exitCode: after.exitCode
    });
  }
  return {
    status: 'deleted',
    reason: null,
    deletedByController: true,
    expectedOid,
    lease
  };
}

function pullNumberReason(value) {
  return Number.isSafeInteger(value) ? `dependent-or-shared-pr-${value}` : 'dependent-or-shared-pr';
}

function parseExactRemoteRef(output, expectedRef) {
  const text = String(output ?? '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/gu);
  if (lines.length !== 1) {
    throw new ProjectsPrError('The remote branch observation was ambiguous.', {
      code: 'cleanup_guard_unavailable'
    });
  }
  const match = lines[0].match(/^([0-9a-f]{40,64})\s+([^\s]+)$/iu);
  if (!match || match[2] !== expectedRef) {
    throw new ProjectsPrError('The remote branch observation was malformed or mismatched.', {
      code: 'cleanup_guard_unavailable'
    });
  }
  return match[1].toLowerCase();
}

function assertAdminAuthorizationStillExact(observed, authorization) {
  const expected = authorization.override?.bypassedRequirements;
  if (!Array.isArray(expected)
    || JSON.stringify(observed.bypassedRequirements) !== JSON.stringify(expected)
    || observed.rulesSha256 !== authorization.override?.observedRulesSha256
    || observed.classicProtectionSha256 !== authorization.override?.classicProtectionSha256) {
    throw new ProjectsPrError('Observable admin requirements changed after authorization.', {
      code: 'stale_admin_authorization'
    });
  }
}

async function markPullRequestReady(runner, state, authorization) {
  const result = await invokeBounded(runner, 'gh', [
    'pr', 'ready', String(authorization.pullRequest.number),
    '--repo', state.github.repositorySpecifier
  ], state.repositoryRoot);
  if (result.exitCode !== 0) {
    throw new ProjectsPrError('The authorized draft could not be marked ready.', {
      code: 'pull_request_ready_failed', exitCode: result.exitCode
    });
  }
}

async function mergeAuthorizedPullRequest(runner, state, authorization, method) {
  if (authorization.mode === 'admin') {
    const methodFlag = { merge: '--merge', squash: '--squash', rebase: '--rebase' }[method];
    const result = await invokeBounded(runner, 'gh', [
      'pr', 'merge', String(authorization.pullRequest.number),
      '--repo', state.github.repositorySpecifier,
      '--admin', '--match-head-commit', authorization.pullRequest.headOid,
      methodFlag
    ], state.repositoryRoot);
    if (result.exitCode !== 0) {
      throw new ProjectsPrError('The explicit admin merge was refused.', {
        code: 'admin_merge_refused', exitCode: result.exitCode
      });
    }
    return { requestedBy: 'gh-pr-merge-admin', responseCommitOid: null };
  }
  const result = await invokeBounded(runner, 'gh', [
    'api', '--hostname', state.github.host,
    '--method', 'PUT',
    `repos/${state.github.nameWithOwner}/pulls/${authorization.pullRequest.number}/merge`,
    '-f', `sha=${authorization.pullRequest.headOid}`,
    '-f', `merge_method=${method}`
  ], state.repositoryRoot);
  if (result.exitCode !== 0) {
    throw new ProjectsPrError('The exact-head reviewed merge was refused.', {
      code: 'reviewed_merge_refused', exitCode: result.exitCode
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ProjectsPrError('GitHub returned an invalid merge receipt.', { code: 'invalid_gh_receipt' });
  }
  const responseCommitOid = parseOidLine(parsed?.sha);
  if (parsed?.merged !== true || !responseCommitOid) {
    throw new ProjectsPrError('GitHub did not confirm the exact pull request merge.', {
      code: 'reviewed_merge_refused'
    });
  }
  return { requestedBy: 'github-sync-merge-api', responseCommitOid };
}

export async function finishProjectsPr(input = {}, dependencies = {}) {
  const loaded = await loadLifecycle(input, dependencies);
  const { runner, fsApi, statePath, plan } = loaded;
  const now = dependencies.now ?? (() => new Date().toISOString());
  let state = loaded.state;
  let firstChecks = null;
  let secondChecks = null;
  let pullRequest = null;
  let mergeRequest = null;
  try {
    assertCompletedForDelivery(state);
    assertDeliveryRepositoryAllowed(state);
    const authorization = state.delivery?.authorization;
    if (!authorization
      || !['reviewed', 'admin'].includes(authorization.mode)
      || authorization.review?.accepted !== true
      || authorization.owner?.confirmed !== true
      || authorization.review?.reviewedHead !== authorization.pullRequest?.headOid) {
      throw new ProjectsPrError('Finish requires an exact reviewed owner authorization receipt.', {
        code: 'delivery_not_authorized'
      });
    }
    const policy = await readDeliveryPolicy(runner, state, authorization.policy.baseOid);
    assertPolicyMatchesAuthorization(policy, authorization);
    if (authorization.mode === 'admin' && !policy.adminOverride.enabled) {
      throw new ProjectsPrError('Admin override is no longer enabled by the bound policy.', {
        code: 'admin_override_disabled'
      });
    }

    pullRequest = await observeDeliveryPullRequest(runner, state);
    let recoveredMerged = false;
    if (pullRequest.merged) {
      assertAuthorizationMatchesPullRequest(authorization, pullRequest, { requireBaseOid: false });
      if (!pullRequest.mergeCommitOid || !pullRequest.mergedAt) {
        throw new ProjectsPrError('The merged pull request receipt is incomplete.', {
          code: 'invalid_gh_receipt'
        });
      }
      recoveredMerged = !state.delivery?.merged;
      const prior = state.delivery?.merged;
      if (prior && (prior.headOid !== authorization.pullRequest.headOid
        || prior.pullRequestNumber !== authorization.pullRequest.number
        || prior.mergeCommitOid !== pullRequest.mergeCommitOid)) {
        throw new ProjectsPrError('The recorded merge does not match GitHub.', {
          code: 'delivery_identity_mismatch'
        });
      }
      state = {
        ...state,
        delivery: {
          ...state.delivery,
          phase: 'merged',
          merged: prior ?? {
            pullRequestNumber: pullRequest.number,
            headOid: pullRequest.headOid,
            mergeCommitOid: pullRequest.mergeCommitOid,
            mergedAt: pullRequest.mergedAt,
            recordedAt: now(),
            requestedBy: 'observed-after-interruption'
          }
        },
        updatedAt: now()
      };
      await writeState(fsApi, statePath, state);
    } else {
      if (pullRequest.state !== 'OPEN') {
        throw new ProjectsPrError('The authorized pull request is not open.', {
          code: 'delivery_pull_request_not_open'
        });
      }
      assertAuthorizationMatchesPullRequest(authorization, pullRequest, { requireBaseOid: true });
      await assertStandaloneDelivery(runner, state, pullRequest);
      firstChecks = await observeRequiredChecks(runner, state, authorization, policy);
      if (!firstChecks.passed) {
        return {
          ...deliveryReceipt('finish', plan, statePath, state, 'waiting', {
            authorization,
            checks: firstChecks,
            mergeRequested: false,
            cleanup: state.delivery?.cleanup ?? null
          }),
          recovery: deliveryRecovery('finish', plan)
        };
      }

      if (authorization.mode === 'admin') {
        const observedAdmin = await observeAdminRequirements(
          runner, state, authorization, policy.reviewedMerge.method
        );
        assertAdminAuthorizationStillExact(observedAdmin, authorization);
      }
      const beforeReady = await observeDeliveryPullRequest(runner, state);
      assertAuthorizationMatchesPullRequest(authorization, beforeReady, { requireBaseOid: true });
      if (beforeReady.merged || beforeReady.state !== 'OPEN') {
        throw new ProjectsPrError('The pull request changed before readiness.', {
          code: 'stale_delivery_authorization'
        });
      }
      if (beforeReady.draft) {
        await markPullRequestReady(runner, state, authorization);
        state = {
          ...state,
          delivery: { ...state.delivery, phase: 'ready', readyAt: now() },
          updatedAt: now()
        };
        await writeState(fsApi, statePath, state);
      }

      const beforeMerge = await observeDeliveryPullRequest(runner, state);
      assertAuthorizationMatchesPullRequest(authorization, beforeMerge, { requireBaseOid: true });
      if (beforeMerge.merged || beforeMerge.state !== 'OPEN' || beforeMerge.draft) {
        throw new ProjectsPrError('The pull request is not the exact ready pull request.', {
          code: 'stale_delivery_authorization'
        });
      }
      await assertStandaloneDelivery(runner, state, beforeMerge);
      secondChecks = await observeRequiredChecks(runner, state, authorization, policy);
      if (!secondChecks.passed) {
        return {
          ...deliveryReceipt('finish', plan, statePath, state, 'waiting', {
            authorization,
            checks: secondChecks,
            mergeRequested: false,
            cleanup: state.delivery?.cleanup ?? null
          }),
          recovery: deliveryRecovery('finish', plan)
        };
      }
      if (authorization.mode === 'admin') {
        const observedAdmin = await observeAdminRequirements(
          runner, state, authorization, policy.reviewedMerge.method
        );
        assertAdminAuthorizationStillExact(observedAdmin, authorization);
      }
      const exactBeforeMutation = await observeDeliveryPullRequest(runner, state);
      assertAuthorizationMatchesPullRequest(authorization, exactBeforeMutation, { requireBaseOid: true });
      if (exactBeforeMutation.merged || exactBeforeMutation.state !== 'OPEN' || exactBeforeMutation.draft) {
        throw new ProjectsPrError('The pull request changed immediately before merge.', {
          code: 'stale_delivery_authorization'
        });
      }
      if (authorization.mode === 'reviewed'
        && (exactBeforeMutation.mergeable !== true || exactBeforeMutation.mergeableState !== 'clean')) {
        throw new ProjectsPrError('Ordinary delivery requires GitHub to report the exact pull request clean and mergeable.', {
          code: 'ordinary_merge_not_clean'
        });
      }
      if (authorization.mode === 'admin'
        && (exactBeforeMutation.mergeable !== true
          || !['blocked', 'clean'].includes(exactBeforeMutation.mergeableState))) {
        throw new ProjectsPrError('Admin delivery requires a conclusive mergeable GitHub state.', {
          code: 'admin_requirements_unavailable'
        });
      }
      mergeRequest = await mergeAuthorizedPullRequest(
        runner, state, authorization, policy.reviewedMerge.method
      );
      pullRequest = await observeDeliveryPullRequest(runner, state);
      assertAuthorizationMatchesPullRequest(authorization, pullRequest, { requireBaseOid: false });
      if (!pullRequest.merged || !pullRequest.mergeCommitOid || !pullRequest.mergedAt) {
        throw new ProjectsPrError('GitHub did not verify the authorized pull request as merged.', {
          code: 'merge_verification_failed'
        });
      }
      if (mergeRequest.responseCommitOid
        && mergeRequest.responseCommitOid !== pullRequest.mergeCommitOid) {
        throw new ProjectsPrError('GitHub merge receipts disagree on the merge commit.', {
          code: 'merge_verification_failed'
        });
      }
      state = {
        ...state,
        delivery: {
          ...state.delivery,
          phase: 'merged',
          merged: {
            pullRequestNumber: pullRequest.number,
            headOid: pullRequest.headOid,
            mergeCommitOid: pullRequest.mergeCommitOid,
            mergedAt: pullRequest.mergedAt,
            recordedAt: now(),
            requestedBy: mergeRequest.requestedBy
          }
        },
        updatedAt: now()
      };
      await writeState(fsApi, statePath, state);
    }

    let cleanup;
    if (['deleted', 'already-absent'].includes(state.delivery?.cleanup?.status)) {
      const expectedRef = `refs/heads/${state.branch}`;
      const remote = await invokeBounded(runner, 'git', [
        'ls-remote', '--heads', state.remote, expectedRef
      ], state.repositoryRoot);
      if (remote.exitCode !== 0) {
        throw new ProjectsPrError('The terminal remote branch cleanup cannot be reverified.', {
          code: 'cleanup_verification_failed', exitCode: remote.exitCode
        });
      }
      if (parseExactRemoteRef(remote.stdout, expectedRef)) {
        throw new ProjectsPrError('A remotely absent branch reappeared; the old authorization will not delete it.', {
          code: 'remote_branch_reappeared'
        });
      }
      cleanup = state.delivery.cleanup;
    } else {
      cleanup = await cleanupMergedRemoteBranch(runner, state, authorization, policy);
    }
    const waitingForCleanup = cleanup.status === 'waiting';
    state = {
      ...state,
      delivery: {
        ...state.delivery,
        phase: waitingForCleanup ? 'merged' : 'delivered',
        cleanup: { ...cleanup, recordedAt: now() }
      },
      updatedAt: now()
    };
    await writeState(fsApi, statePath, state);
    const receipt = deliveryReceipt('finish', plan, statePath, state,
      waitingForCleanup ? 'waiting' : 'completed', {
        resumed: recoveredMerged || state.delivery.merged.requestedBy === 'observed-after-interruption',
        authorization,
        checks: secondChecks ?? firstChecks,
        merge: state.delivery.merged,
        cleanup: state.delivery.cleanup,
        localBranchPreserved: true,
        evidencePreserved: true
      });
    return waitingForCleanup
      ? { ...receipt, recovery: deliveryRecovery('finish', plan) }
      : receipt;
  } catch (error) {
    throw deliveryFailure(error, 'finish', plan, statePath, state, {
      firstChecks,
      secondChecks,
      pullRequest,
      mergeRequest,
      localBranchPreserved: true,
      evidencePreserved: true
    });
  }
}

async function ensureFinalizeWorktree(state, observed, runner) {
  if (!observed.localBranch.exists || !observed.worktree.registered || !observed.worktree.pathExists) {
    throw new ProjectsPrError('The prepared local branch and exact worktree must still exist.', {
      code: 'prepared_worktree_missing'
    });
  }
  if (!observed.worktree.clean) {
    throw new ProjectsPrError('The worker must leave a committed, clean worktree.', { code: 'dirty_worktree' });
  }
  if (observed.localBranch.oid !== observed.worktree.headOid) {
    throw new ProjectsPrError('The prepared branch and worktree HEAD do not match.', { code: 'local_state_mismatch' });
  }
  const ancestor = await git(runner, state.repositoryRoot, ['merge-base', '--is-ancestor', state.baseCommit, observed.worktree.headOid], 'Base ancestry check', state.worktreePath, [0, 1]);
  if (ancestor.exitCode !== 0) {
    throw new ProjectsPrError('The prepared head is not descended from the recorded base commit.', {
      code: 'base_history_mismatch'
    });
  }
  const countText = (await git(runner, state.repositoryRoot, ['rev-list', '--count', `${state.baseCommit}..${observed.worktree.headOid}`], 'Change commit check', state.worktreePath)).stdout.trim();
  if (!/^\d+$/u.test(countText) || Number(countText) < 1) {
    throw new ProjectsPrError('The side-chat worker must create at least one commit beyond the recorded base.', {
      code: 'no_change_commit'
    });
  }
  return Number(countText);
}

export async function finalizeProjectsPr(input = {}, dependencies = {}) {
  const loaded = await loadLifecycle(input, dependencies);
  const { runner, fsApi, statePath, plan } = loaded;
  const now = dependencies.now ?? (() => new Date().toISOString());
  let state = loaded.state;
  if (state.phase === 'aborted') {
    throw failure(
      new ProjectsPrError('An aborted projects-pr lifecycle cannot be finalized.', { code: 'invalid_state_phase' }),
      'finalize', plan, null, statePath, state
    );
  }
  if (state.phase === 'completed') {
    return lifecycleReceipt('finalize', plan, null, statePath, state, 'completed', {
      resumed: true,
      verification: { commandSha256: plan.verificationCommandSha256, passed: true, exitCode: 0, reused: true },
      pushedRefspec: `HEAD:refs/heads/${plan.branch}`,
      draftPullRequest: state.draftPullRequest,
      ownerDecision: createProjectsPrOwnerDecision({
        draftPullRequest: state.draftPullRequest,
        pushedRefspec: `HEAD:refs/heads/${plan.branch}`,
        verificationCommandSha256: plan.verificationCommandSha256
      }),
      cleanup: { worktreeRemoved: true, localBranchPreserved: true }
    });
  }
  const doctor = await runProjectsPrDoctor({
    repositoryRoot: plan.repositoryRoot,
    baseBranch: plan.baseBranch,
    remote: plan.remote
  }, dependencies);
  if (!doctor.capability.available) throw unavailableError('finalize', plan, doctor);
  let observed;
  let verificationPassed = false;
  let pushedRefspec = null;
  let draftPullRequest = state.draftPullRequest;
  let commitCount = null;
  let reusedPush = false;
  let reusedPullRequest = false;
  try {
    assertDoctorMatchesState(doctor, state);
    observed = await observeState(state, runner, fsApi);
    if (state.phase === 'pr_created'
      && !observed.worktree.registered
      && !observed.worktree.pathExists
      && observed.localBranch.oid === state.verifiedCommit
      && observed.remoteBranch.reachable
      && observed.remoteBranch.oid === state.verifiedCommit
      && observed.githubQuery.available
      && observed.pullRequestCount === 1) {
      draftPullRequest = await verifyPullRequest(
        runner,
        state,
        observed.draftPullRequest,
        state.verifiedCommit,
        'Resumed draft pull request verification'
      );
      pushedRefspec = `HEAD:refs/heads/${state.branch}`;
      state = { ...state, phase: 'completed', draftPullRequest, updatedAt: now() };
      await writeState(fsApi, statePath, state);
      return lifecycleReceipt('finalize', plan, doctor, statePath, state, 'completed', {
        resumed: true,
        verification: { commandSha256: plan.verificationCommandSha256, passed: true, exitCode: 0, reused: true },
        pushedRefspec,
        draftPullRequest,
        ownerDecision: createProjectsPrOwnerDecision({
          draftPullRequest,
          pushedRefspec,
          verificationCommandSha256: plan.verificationCommandSha256
        }),
        cleanup: { worktreeRemoved: true, localBranchPreserved: true }
      });
    }
    commitCount = await ensureFinalizeWorktree(state, observed, runner);
    const headOid = observed.worktree.headOid;
    const verification = await invoke(runner, plan.verificationCommand, [], state.worktreePath, true);
    if (verification.exitCode !== 0) {
      throw new ProjectsPrError('Verification failed; the worktree was preserved.', {
        code: 'verification_failed',
        exitCode: verification.exitCode
      });
    }
    verificationPassed = true;
    const afterStatus = await git(runner, state.repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=normal'], 'Post-verification cleanliness check', state.worktreePath);
    const afterHead = parseOidLine((await git(runner, state.repositoryRoot, ['rev-parse', 'HEAD'], 'Post-verification head check', state.worktreePath)).stdout);
    if (afterStatus.stdout.trim() || afterHead !== headOid) {
      throw new ProjectsPrError('Verification changed the prepared worktree or HEAD.', { code: 'verification_mutated_worktree' });
    }

    observed = await observeState(state, runner, fsApi);
    if (!observed.remoteBranch.reachable) {
      throw new ProjectsPrError('The remote branch could not be observed.', { code: 'remote_access_failed' });
    }
    if (observed.remoteBranch.exists && observed.remoteBranch.oid !== headOid) {
      throw new ProjectsPrError('The remote branch exists at a different commit.', { code: 'remote_branch_mismatch' });
    }
    reusedPush = observed.remoteBranch.exists;
    if (!observed.remoteBranch.exists) {
      await git(runner, state.repositoryRoot, ['push', '--set-upstream', state.remote, `HEAD:refs/heads/${state.branch}`], 'Exact branch push', state.worktreePath);
    }
    const pushed = await git(runner, state.repositoryRoot, ['ls-remote', '--heads', state.remote, `refs/heads/${state.branch}`], 'Pushed branch verification');
    if (parseOidLine(pushed.stdout) !== headOid) {
      throw new ProjectsPrError('The pushed branch did not resolve to the verified commit.', {
        code: 'push_verification_failed'
      });
    }
    pushedRefspec = `HEAD:refs/heads/${state.branch}`;
    state = {
      ...state,
      phase: 'pushed',
      verifiedCommit: headOid,
      verificationPassedAt: now(),
      pushedCommit: headOid,
      updatedAt: now()
    };
    await writeState(fsApi, statePath, state);

    observed = await observeState(state, runner, fsApi);
    if (!observed.githubQuery.available) {
      throw new ProjectsPrError('GitHub pull request state could not be observed.', {
        code: 'github_pr_observation_failed'
      });
    }
    if (observed.pullRequestCount > 1) {
      throw new ProjectsPrError('More than one pull request exists for the prepared branch.', {
        code: 'pull_request_mismatch'
      });
    }
    let pullIdentity;
    if (observed.pullRequestCount === 1) {
      reusedPullRequest = true;
      pullIdentity = {
        number: observed.draftPullRequest.number,
        url: observed.draftPullRequest.url
      };
    } else {
      const body = [
        `Projects pack: ${state.packId}`,
        '',
        'Created from one reviewed, low-energy Projects worker handoff.',
        `Verification command SHA-256: ${state.verificationCommandSha256}`,
        '',
        'Owner review is required. Finalization never merges or enables auto-merge.'
      ].join('\n');
      const created = await checked(runner, 'gh', [
        'pr', 'create', '--repo', state.github.repositorySpecifier, '--draft',
        '--base', state.baseBranch, '--head', state.branch,
        '--title', state.title, '--body', body
      ], state.worktreePath, 'Draft pull request creation');
      const prUrl = created.stdout.match(/https:\/\/\S+/u)?.[0] ?? null;
      if (!prUrl) {
        throw new ProjectsPrError('GitHub CLI did not return a pull request URL.', {
          code: 'invalid_gh_receipt'
        });
      }
      pullIdentity = { url: prUrl };
    }
    draftPullRequest = await verifyPullRequest(
      runner,
      state,
      pullIdentity,
      headOid,
      'Draft pull request verification'
    );
    state = { ...state, phase: 'pr_created', draftPullRequest, updatedAt: now() };
    await writeState(fsApi, statePath, state);

    const cleanupStatus = await git(runner, state.repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=normal'], 'Cleanup safety check', state.worktreePath);
    const cleanupHead = parseOidLine((await git(runner, state.repositoryRoot, ['rev-parse', 'HEAD'], 'Cleanup head check', state.worktreePath)).stdout);
    if (cleanupStatus.stdout.trim() || cleanupHead !== headOid) {
      throw new ProjectsPrError('Cleanup refused because the worktree changed after verification.', {
        code: 'cleanup_refused'
      });
    }
    await git(runner, state.repositoryRoot, ['worktree', 'remove', state.worktreePath], 'Exact worktree cleanup');
    state = { ...state, phase: 'completed', updatedAt: now() };
    await writeState(fsApi, statePath, state);
    return lifecycleReceipt('finalize', plan, doctor, statePath, state, 'completed', {
      resumed: reusedPush || reusedPullRequest,
      commitCount,
      verification: { commandSha256: plan.verificationCommandSha256, passed: true, exitCode: 0, reused: false },
      pushedRefspec,
      draftPullRequest,
      ownerDecision: createProjectsPrOwnerDecision({
        draftPullRequest,
        pushedRefspec,
        verificationCommandSha256: plan.verificationCommandSha256
      }),
      cleanup: { worktreeRemoved: true, localBranchPreserved: true }
    });
  } catch (error) {
    throw failure(error, 'finalize', plan, doctor, statePath, state, {
      verification: {
        commandSha256: plan.verificationCommandSha256,
        passed: verificationPassed,
        exitCode: error instanceof ProjectsPrError ? error.exitCode : null
      },
      pushedRefspec,
      draftPullRequest,
      observed,
      cleanup: { worktreeRemoved: false, preservedForDiagnosis: true, localBranchPreserved: true }
    });
  }
}

export async function abortProjectsPr(input = {}, dependencies = {}) {
  const loaded = await loadLifecycle(input, dependencies);
  const { runner, fsApi, statePath, plan } = loaded;
  const now = dependencies.now ?? (() => new Date().toISOString());
  let state = loaded.state;
  if (state.phase === 'aborted') {
    return lifecycleReceipt('abort', plan, null, statePath, state, 'aborted', {
      resumed: true,
      cleanup: { worktreeRemoved: true, localBranchRemoved: true }
    });
  }
  if (state.phase === 'completed') {
    throw failure(
      new ProjectsPrError('Completed projects-pr state cannot be aborted.', { code: 'abort_refused' }),
      'abort', plan, null, statePath, state
    );
  }
  const doctor = await runProjectsPrDoctor({
    repositoryRoot: plan.repositoryRoot,
    baseBranch: plan.baseBranch,
    remote: plan.remote
  }, dependencies);
  if (!doctor.capability.available) throw unavailableError('abort', plan, doctor);
  let observed;
  try {
    assertDoctorMatchesState(doctor, state);
    observed = await observeState(state, runner, fsApi);
    if (!observed.remoteBranch.reachable || !observed.githubQuery.available) {
      throw new ProjectsPrError('Abort requires conclusive remote branch and pull request observations.', {
        code: 'abort_refused'
      });
    }
    if (observed.remoteBranch.exists || (observed.pullRequestCount ?? 0) > 0) {
      throw new ProjectsPrError('Abort refused because a remote branch or pull request exists.', {
        code: 'abort_refused'
      });
    }
    if (observed.worktree.pathExists !== observed.worktree.registered) {
      throw new ProjectsPrError('Abort refused because the worktree path and Git registration disagree.', {
        code: 'abort_refused'
      });
    }
    if (observed.worktree.registered) {
      if (!observed.worktree.clean || observed.worktree.headOid !== state.baseCommit || observed.localBranch.oid !== state.baseCommit) {
        throw new ProjectsPrError('Abort removes only an unchanged prepared worktree at the recorded base commit.', {
          code: 'abort_refused'
        });
      }
      await git(runner, state.repositoryRoot, ['worktree', 'remove', state.worktreePath], 'Abort worktree cleanup');
    }
    if (observed.localBranch.exists) {
      await git(runner, state.repositoryRoot, ['branch', '-d', state.branch], 'Abort local branch cleanup');
    }
    state = { ...state, phase: 'aborted', updatedAt: now() };
    await writeState(fsApi, statePath, state);
    return lifecycleReceipt('abort', plan, doctor, statePath, state, 'aborted', {
      resumed: false,
      cleanup: { worktreeRemoved: observed.worktree.registered, localBranchRemoved: observed.localBranch.exists }
    });
  } catch (error) {
    throw failure(error, 'abort', plan, doctor, statePath, state, { observed });
  }
}
