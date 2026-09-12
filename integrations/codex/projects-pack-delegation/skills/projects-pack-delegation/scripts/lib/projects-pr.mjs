// This is the public CLI/package entry point. Core is private implementation,
// preserved without edits; nested core calls execute under the outer lock.
import path from 'node:path';
import * as core from './projects-pr-core.mjs';
import { LifecycleLockError, withRepositoryLifecycleLock } from './repository-lock.mjs';
import { createProcessSession, defaultProjectsPrRunner } from './bounded-process.mjs';
import { newPlanVerificationCommand, VerificationCommandError } from './verification-command.mjs';
import { captureMutationInput, MutationInputError } from './mutation-input.mjs';
export * from './projects-pr-core.mjs';
export { defaultProjectsPrRunner };

// New assignments must fit the existing handoff/review contract. Core's legacy
// plan reader stays unchanged for observing and recovering previously saved state.
export function createProjectsPrPlan(input = {}) {
  let verificationCommand;
  try { verificationCommand = newPlanVerificationCommand(input); }
  catch (error) {
    if (!(error instanceof VerificationCommandError)) throw error;
    throw new core.ProjectsPrError(error.message, { code: 'invalid_input' });
  }
  return core.createProjectsPrPlan({ ...input, verificationCommand });
}

async function locked(command, implementation, input, dependencies) {
  // Bind the operation and its recovery receipt before lock discovery can yield.
  try { input = captureMutationInput(command, input); }
  catch (error) {
    if (!(error instanceof MutationInputError)) throw error;
    throw new core.ProjectsPrError(error.message, { code: 'invalid_input' });
  }
  // Required identifiers must still fail as invalid_input before repository I/O.
  // Core retains the complete command-specific validation and authority checks.
  const packIds = command === 'stack' ? input.packIds : [input.packId];
  if (!Array.isArray(packIds) || packIds.length < (command === 'stack' ? 2 : 1)
      || packIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(String(id ?? '').trim()))) {
    throw new core.ProjectsPrError('Valid delegated pack identifiers are required.', { code: 'invalid_input' });
  }
  const rootText = String(input.repositoryRoot ?? process.cwd()).trim();
  if (!rootText || rootText.length > 1000) {
    throw new core.ProjectsPrError('A valid repositoryRoot is required.', { code: 'invalid_input' });
  }
  const repositoryRoot = path.resolve(rootText);
  input = Object.freeze({ ...input, repositoryRoot });
  if (command === 'prepare') {
    const plan = createProjectsPrPlan(input);
    // Capture validated plan values before the first await; caller mutation must
    // not replace the command (or its assignment) while lock discovery is pending.
    input = Object.freeze({ ...input, ...plan });
  }
  // Capture dependency references, not their trusted implementation internals.
  dependencies = Object.freeze({ ...dependencies });
  const session = createProcessSession(dependencies.runner ?? defaultProjectsPrRunner);
  try {
    return await withRepositoryLifecycleLock(repositoryRoot,
      () => core[implementation](input, { ...dependencies, runner: session.runner }), {
        runner: session.runner, fs: dependencies.fs, canRelease: session.canRelease
      });
  } catch (error) {
    if (!(error instanceof LifecycleLockError)) throw error;
    const packId = command === 'stack' ? input.packIds?.[0] : input.packId;
    const validPack = typeof packId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(packId);
    const validRoot = typeof repositoryRoot === 'string' && repositoryRoot.trim()
      && repositoryRoot.length <= 1000 && !/[\u0000-\u001f\u007f]/u.test(repositoryRoot);
    const args = validRoot ? ['--repo', path.resolve(repositoryRoot.trim())] : [];
    if (validPack) args.push('--pack-id', packId);
    throw new core.ProjectsPrError(error.message, { code: error.code, receipt: {
      schemaVersion: core.PROJECTS_PR_SCHEMA_VERSION, kind: 'projects-pr', command,
      status: 'failed', error: { code: error.code, message: error.message, exitCode: null },
      operationOutcome: error.operationOutcome,
      recovery: { nextCommand: validPack ? 'status' : 'doctor', args,
        manualAction: 'Inspect docs/lifecycle-lock.md. Never automatically delete or bypass a lock.' }
    } });
  }
}

export async function prepareProjectsPr(input = {}, dependencies = {}) {
  return locked('prepare', 'prepareProjectsPr', input, dependencies);
}
export async function finalizeProjectsPr(input = {}, dependencies = {}) {
  return locked('finalize', 'finalizeProjectsPr', input, dependencies);
}
export async function abortProjectsPr(input = {}, dependencies = {}) {
  return locked('abort', 'abortProjectsPr', input, dependencies);
}
export async function stackProjectsPr(input = {}, dependencies = {}) {
  return locked('stack', 'stackProjectsPr', input, dependencies);
}
export async function authorizeProjectsPr(input = {}, dependencies = {}) {
  return locked('authorize', 'authorizeProjectsPr', input, dependencies);
}
export async function authorizeAdminProjectsPr(input = {}, dependencies = {}) {
  return locked('authorize-admin', 'authorizeAdminProjectsPr', input, dependencies);
}
export async function finishProjectsPr(input = {}, dependencies = {}) {
  return locked('finish', 'finishProjectsPr', input, dependencies);
}

async function observed(command, implementation, input, dependencies) {
  const session = createProcessSession(dependencies.runner ?? defaultProjectsPrRunner);
  let result; let caught; let failed = false;
  try { result = await core[implementation](input, { ...dependencies, runner: session.runner }); }
  catch (error) { caught = error; failed = true; }
  if (!session.canRelease()) {
    const message = 'Subprocess observation was interrupted. No automatic retry was performed.';
    throw new core.ProjectsPrError(message, { code: 'subprocess_uncertain', receipt: {
      schemaVersion: core.PROJECTS_PR_SCHEMA_VERSION, kind: 'projects-pr', command,
      status: 'failed', error: { code: 'subprocess_uncertain', message, exitCode: null }
    } });
  }
  if (failed) throw caught;
  return result;
}

// Read-only entry points get deadlines without acquiring or removing a lock.
export async function runProjectsPrDoctor(input = {}, dependencies = {}) {
  return observed('doctor', 'runProjectsPrDoctor', input, dependencies);
}
export async function statusProjectsPr(input = {}, dependencies = {}) {
  return observed('status', 'statusProjectsPr', input, dependencies);
}
