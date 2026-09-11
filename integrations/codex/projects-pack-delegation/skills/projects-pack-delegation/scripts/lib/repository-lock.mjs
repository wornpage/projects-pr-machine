import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const LIFECYCLE_LOCK_NAME = 'projects-pr-v2.lock';
const OWNER_NAME = 'owner.json';
const READ_TIMEOUT_MS = 10_000;
const MAX_PATH_BYTES = 8192;
const MESSAGES = Object.freeze({
  lifecycle_lock_unavailable: 'Cannot establish the repository lifecycle lock.',
  lifecycle_locked: 'A lifecycle lock already exists. Inspect the active or interrupted operation; do not automatically remove it.',
  lifecycle_lock_initialization_failed: 'Lock initialization failed. Preserve the lock and investigate before retrying.',
  lifecycle_lock_release_failed: 'Lock ownership or cleanup is uncertain. Effects may have occurred; inspect status before retrying.'
});

export class LifecycleLockError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.name = 'LifecycleLockError';
    this.code = code;
    this.operationOutcome = 'not_started';
  }
}
const fail = code => new LifecycleLockError(code);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const samePath = (a, b) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Internal cooperating-process lock. The runner/fs seams are trusted tests only. */
export async function acquireRepositoryLifecycleLock(repositoryRoot, { runner, fs: fsApi = fs } = {}) {
  let root; let commonDir;
  try {
    if (typeof repositoryRoot !== 'string' || !repositoryRoot.trim()
        || repositoryRoot.length > 1000 || /[\u0000-\u001f\u007f]/u.test(repositoryRoot)
        || typeof runner !== 'function') throw Error();
    root = await fsApi.realpath(path.resolve(repositoryRoot.trim()));
    async function gitPath(args) {
      const result = await runner({ executable: 'git', args, cwd: root, shell: false,
        timeoutMs: READ_TIMEOUT_MS });
      if (result?.exitCode !== 0 || typeof result.stdout !== 'string'
          || Buffer.byteLength(result.stdout) > MAX_PATH_BYTES) throw Error();
      const value = result.stdout.replace(/\r?\n$/u, '');
      if (!value || /[\u0000-\u001f\u007f]/u.test(value)) throw Error();
      return value;
    }
    const top = await gitPath(['rev-parse', '--show-toplevel']);
    if (!path.isAbsolute(top) || !samePath(root, await fsApi.realpath(top))) throw Error();
    commonDir = await fsApi.realpath(path.resolve(root, await gitPath(['rev-parse', '--git-common-dir'])));
    if (!(await fsApi.lstat(commonDir)).isDirectory()) throw Error();
  } catch { throw fail('lifecycle_lock_unavailable'); }

  const lockPath = path.join(commonDir, LIFECYCLE_LOCK_NAME);
  const ownerPath = path.join(lockPath, OWNER_NAME);
  try {
    // No check-then-create window, recursive creation, retry, lease, or PID-based takeover.
    await fsApi.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    throw fail(error?.code === 'EEXIST' ? 'lifecycle_locked' : 'lifecycle_lock_unavailable');
  }
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1,
    kind: 'projects-pr-lifecycle-lock', token: randomUUID(), pid: process.pid,
    startedAt: new Date().toISOString() })}\n`);
  let directoryIdentity; let ownerIdentity; let handle;
  try {
    directoryIdentity = await fsApi.lstat(lockPath, { bigint: true });
    if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) throw Error();
    handle = await fsApi.open(ownerPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    ownerIdentity = await handle.stat({ bigint: true });
    await handle.close(); handle = null;
  } catch {
    if (handle) await handle.close().catch(() => {});
    // Initialization may have been interrupted. Never guess that partial state is stale.
    throw fail('lifecycle_lock_initialization_failed');
  }

  let releasePromise;
  async function releaseOwnedLock() {
    let reader;
    try {
      const directory = await fsApi.lstat(lockPath, { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink()
          || !sameIdentity(directory, directoryIdentity)) throw Error();
      const entries = await fsApi.readdir(lockPath);
      if (entries.length !== 1 || entries[0] !== OWNER_NAME) throw Error();
      const owner = await fsApi.lstat(ownerPath, { bigint: true });
      if (!owner.isFile() || owner.isSymbolicLink() || owner.nlink !== 1n
          || !sameIdentity(owner, ownerIdentity) || owner.size !== BigInt(bytes.length)) throw Error();
      reader = await fsApi.open(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!sameIdentity(await reader.stat({ bigint: true }), ownerIdentity)) throw Error();
      const buffer = Buffer.alloc(bytes.length + 1);
      const { bytesRead } = await reader.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== bytes.length || !buffer.subarray(0, bytesRead).equals(bytes)) throw Error();
      await reader.close(); reader = null;
      await fsApi.unlink(ownerPath);
      // Never recursively delete: foreign/new contents must leave a blocking lock.
      await fsApi.rmdir(lockPath);
    } catch { throw fail('lifecycle_lock_release_failed'); }
    finally { if (reader) await reader.close().catch(() => {}); }
  }
  // Concurrent/repeated release attempts share one outcome and never repeat deletion.
  return () => (releasePromise ??= releaseOwnedLock());
}

export async function withRepositoryLifecycleLock(repositoryRoot, operation, dependencies) {
  if (typeof operation !== 'function') throw fail('lifecycle_lock_unavailable');
  const release = await acquireRepositoryLifecycleLock(repositoryRoot, dependencies);
  let result; let operationError; let failed = false;
  try { result = await operation(); }
  catch (error) { operationError = error; failed = true; }
  try { await release(); }
  catch (error) {
    error.operationOutcome = failed ? 'failed' : 'returned';
    // No original messages, output, paths, or verification text in cleanup diagnostics.
    throw error;
  }
  if (failed) throw operationError;
  return result;
}
