import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createCodeHandoffAcceptanceSchema } from '../../../contracts/code-handoff-acceptance.mjs';

// Git recognizes /dev/null on Windows too; Node's os.devNull is not a Git config path.
const devNull = '/dev/null';
const execute = promisify(execFile);
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 256;
const TIMEOUT_MS = 10000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const utf8 = value => new TextDecoder('utf-8', { fatal: true }).decode(value);
const samePath = (a, b) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b;

function refusal(code) {
  const error = new Error(`Code review snapshot refused: ${code}.`);
  error.code = code;
  return error;
}

/** Only fixed read operations are passed here. No shell or verification runs. */
export async function defaultReviewGitRunner({ args, cwd }) {
  // Do not inherit Git redirection, config injection, tracing, or replacement
  // settings. Executables and the host environment must still be trusted.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^GIT_/iu.test(key)));
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, LC_ALL: 'C'
  });
  try {
    const result = await execute('git', [
      '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', `diff.orderFile=${devNull}`, ...args
    ], { cwd, env, encoding: 'buffer', shell: false, windowsHide: true,
      timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    if (error?.killed || error?.signal || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw refusal('git_read_incomplete');
    }
    // Never propagate stderr, stdout, command arguments, or error messages.
    return { exitCode: Number.isInteger(error?.code) ? error.code : -1, stdout: Buffer.alloc(0) };
  }
}

/**
 * Capture consistency evidence for a clean, committed Git-backed assignment.
 * Digests are not signatures, proof of tests, or permission to accept or merge.
 * The optional runner is a trusted test seam; CLI callers cannot replace it.
 */
export async function createCodeReviewSnapshot(input, { runner = defaultReviewGitRunner } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.repositoryRoot !== 'string' || !path.isAbsolute(input.repositoryRoot)
      || typeof input.baseOid !== 'string' || !OID.test(input.baseOid)
      || typeof input.headOid !== 'string' || !OID.test(input.headOid)
      || input.baseOid.length !== input.headOid.length
      || (input.expectedContextSha256 !== undefined && (typeof input.expectedContextSha256 !== 'string'
        || !DIGEST.test(input.expectedContextSha256)))) {
    throw refusal('invalid_input');
  }
  // Reuse v1-compatible identity and literal-command validation without ever
  // interpreting or executing that command. Fail before making any Git read.
  try {
    createCodeHandoffAcceptanceSchema({ packId: input.packId, workerId: input.workerId,
      verificationCommand: input.verificationCommand });
  } catch { throw refusal('invalid_assignment'); }
  const { packId, workerId, verificationCommand, baseOid, headOid, expectedContextSha256 } = input;
  let root;
  try { root = await realpath(input.repositoryRoot); }
  catch { throw refusal('repository_unavailable'); }

  async function git(args, allowed = [0]) {
    let result;
    try { result = await runner({ args, cwd: root, timeoutMs: TIMEOUT_MS, maxBuffer: MAX_BYTES }); }
    catch { throw refusal('git_read_incomplete'); }
    if (!result || !allowed.includes(result.exitCode) || !Buffer.isBuffer(result.stdout)) {
      throw refusal('git_read_failed');
    }
    if (result.stdout.length > MAX_BYTES) throw refusal('git_read_incomplete');
    return result;
  }
  async function text(args) {
    try { return utf8((await git(args)).stdout).trimEnd(); }
    catch (error) { throw error?.code ? error : refusal('unsupported_git_output'); }
  }
  const top = await text(['rev-parse', '--show-toplevel']);
  let canonicalTop;
  try { canonicalTop = await realpath(top); }
  catch { throw refusal('repository_mismatch'); }
  if (!samePath(root, canonicalTop)) throw refusal('repository_mismatch');
  const common = await text(['rev-parse', '--git-common-dir']);
  let commonDir;
  try { commonDir = await realpath(path.resolve(root, common)); }
  catch { throw refusal('repository_unavailable'); }

  for (const oid of [baseOid, headOid]) {
    if (await text(['rev-parse', '--verify', `${oid}^{commit}`]) !== oid) {
      throw refusal('commit_mismatch');
    }
  }
  if ((await git(['merge-base', '--is-ancestor', baseOid, headOid], [0, 1])).exitCode !== 0) {
    throw refusal('base_not_ancestor');
  }
  async function stableHead() {
    if (await text(['rev-parse', '--verify', 'HEAD']) !== headOid) throw refusal('head_changed');
    // Even status can run a clean/process filter while comparing working files.
    // Inspect names only; never read or reflect the configured command text.
    const filters = await git(['config', '--name-only', '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process)$'], [0, 1]);
    if (filters.exitCode === 0) throw refusal('content_filters_unsupported');
    // Nested repositories have their own filters/config. Do not recurse into
    // those configurations under a claim of read-only parent inspection.
    const staged = (await git(['ls-files', '--stage', '-z'])).stdout.toString('utf8');
    if (staged.split('\0').some(entry => entry.startsWith('160000 '))) {
      throw refusal('submodules_unsupported');
    }
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
    if (status.stdout.length) throw refusal('dirty_worktree');
    const flags = (await git(['ls-files', '-v', '-z'])).stdout;
    // Git status can hide local modifications under these index flags. Refuse
    // such indexes rather than describe a sparse/assume-unchanged view as clean.
    for (const entry of flags.toString('utf8').split('\0').filter(Boolean)) {
      if (/^[a-zS]/u.test(entry)) throw refusal('hidden_index_entries');
    }
  }
  await stableHead();
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
    '--no-relative', '--ignore-submodules=none', '--submodule=short', '--full-index',
    '--binary', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3',
    '--diff-algorithm=myers', '--no-indent-heuristic', baseOid, headOid, '--'];
  const patch = (await git(diffArgs)).stdout;
  let entries;
  try {
    const raw = utf8((await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--ignore-submodules=none', '--name-status', '-z', baseOid, headOid, '--'])).stdout);
    if (!raw.endsWith('\0')) throw refusal('empty_or_invalid_diff');
    entries = raw.slice(0, -1).split('\0');
  } catch (error) { throw error?.code ? error : refusal('unsupported_git_output'); }
  if (!patch.length || entries.length % 2 || entries.length > MAX_FILES * 2) {
    throw refusal('empty_or_oversized_diff');
  }
  const files = [];
  for (let i = 0; i < entries.length; i += 2) {
    const [status, file] = entries.slice(i, i + 2);
    if (!/^[ADMT]$/u.test(status) || !file || [...file].length > 500
        || file.startsWith('/') || /^[A-Za-z]:/u.test(file)
        || /[\\\u0000-\u001f\u007f]/u.test(file) || file.split('/').includes('..')) {
      throw refusal('unsupported_changed_path');
    }
    files.push({ status, path: file });
  }
  await stableHead();
  // A second observation detects ordinary concurrent changes, not change-and-
  // restore races. The coordinator must keep the worker quiescent through review.
  if (await text(['rev-parse', '--verify', 'HEAD']) !== headOid) throw refusal('head_changed');
  const snapshot = {
    schemaVersion: 1, kind: 'code-review-snapshot', repositoryRoot: root, gitCommonDir: commonDir,
    packId, workerId, baseOid, headOid, verificationCommandSha256: sha256(verificationCommand),
    diffSha256: sha256(patch), diffBytes: patch.length, files
  };
  const contextSha256 = sha256(JSON.stringify(snapshot));
  if (expectedContextSha256 !== undefined && expectedContextSha256 !== contextSha256) {
    throw refusal('review_context_changed');
  }
  // The manifest omits command text and patch contents; pass it only in the
  // authorized native review context. Local paths and assignment IDs are scoped data.
  return { ...snapshot, contextSha256, diffArgs };
}

export function parseReviewSnapshotArgs(argv) {
  const flags = new Map([
    ['--repo', 'repositoryRoot'], ['--base', 'baseOid'], ['--head', 'headOid'],
    ['--pack-id', 'packId'], ['--worker-id', 'workerId'], ['--verify-command', 'verificationCommand'],
    ['--expect-context', 'expectedContextSha256']
  ]);
  const input = {};
  if (argv.length % 2) throw refusal('invalid_arguments');
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags.get(argv[i]);
    if (!key || Object.hasOwn(input, key) || typeof argv[i + 1] !== 'string') {
      throw refusal('invalid_arguments');
    }
    input[key] = argv[i + 1];
  }
  if ([...flags.values()].slice(0, 6).some(key => !Object.hasOwn(input, key))) {
    throw refusal('invalid_arguments');
  }
  return input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await createCodeReviewSnapshot(parseReviewSnapshotArgs(process.argv.slice(2)))));
  } catch (error) {
    // Closed diagnostics: no arbitrary subprocess or caller data is reflected.
    const code = typeof error?.code === 'string' && /^[a-z_]+$/u.test(error.code)
      ? error.code : 'snapshot_failed';
    console.log(JSON.stringify({ kind: 'code-review-snapshot', status: 'refused', error: code }));
    process.exitCode = 1;
  }
}
