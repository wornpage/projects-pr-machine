import { spawn } from 'node:child_process';

export const PROCESS_TIMEOUT_MS = 30_000;
export const VERIFICATION_TIMEOUT_MS = 15 * 60_000;
export const PROCESS_OUTPUT_BYTES = 1024 * 1024; // Per stream, as in the original runner.

const failure = (reason, processUncertain = false) => ({
  exitCode: 1, stdout: '', stderr: '', terminationReason: reason, processUncertain
});

/** Internal policy; no CLI/environment override or worker-supplied runner options. */
export function processOptions(invocation, platform = process.platform) {
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) throw Error();
  const { executable, args = [], cwd, shell = false, timeoutMs } = invocation;
  if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || typeof shell !== 'boolean' || (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0')))) throw Error();
  const timeout = timeoutMs === undefined
    ? (shell ? VERIFICATION_TIMEOUT_MS : PROCESS_TIMEOUT_MS) : timeoutMs;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > VERIFICATION_TIMEOUT_MS) throw Error();
  return {
    executable: shell ? (platform === 'win32' ? 'pwsh' : '/bin/sh') : executable,
    args: shell ? (platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', executable]
      : ['-c', executable]) : [...args],
    cwd, timeoutMs: timeout
  };
}

/** Trusted dependency seams are for tests only, never accepted from CLI/JSON input. */
export function createBoundedProcessRunner({ spawnProcess = spawn, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return async invocation => {
    let options;
    try { options = processOptions(invocation); }
    catch { return failure('invalid_invocation'); }
    return new Promise(resolve => {
      let child; let timer; let settled = false; let spawned = false; let exited = false;
      const chunks = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        if (result.processUncertain) {
          // Killing this child is an attempt, not evidence of descendant quiescence.
          // Never signal an already observed exited PID (it may have been reused).
          if (!exited && (spawned || Number.isInteger(child?.pid))) {
            try { child.kill('SIGKILL'); } catch { /* Retain uncertainty. */ }
          }
          // Descendants may hold inherited pipes after exit; do not await their EOF.
          child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
        }
        chunks.stdout.length = 0; chunks.stderr.length = 0;
        resolve(result);
      };
      const interrupt = reason => finish(failure(reason, true));
      try {
        child = spawnProcess(options.executable, options.args, {
          cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch { finish(failure('spawn_failed')); return; }
      child.once('spawn', () => { spawned = true; });
      child.on('error', () => {
        if (spawned || Number.isInteger(child.pid)) interrupt('process_error');
        else finish(failure('spawn_failed'));
      });
      child.once('exit', (_code, signal) => {
        exited = true;
        if (signal) interrupt('signal');
      });
      child.once('close', (code, signal) => {
        exited = true;
        if (settled) return;
        if (signal || !Number.isInteger(code) || code < 0) { interrupt('signal'); return; }
        finish({ exitCode: code,
          stdout: Buffer.concat(chunks.stdout, sizes.stdout).toString('utf8'),
          stderr: Buffer.concat(chunks.stderr, sizes.stderr).toString('utf8') });
      });
      for (const name of ['stdout', 'stderr']) {
        child[name].on('error', () => interrupt('stream_error'));
        child[name].on('data', chunk => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk)) { interrupt('stream_error'); return; }
          if (sizes[name] + chunk.length > PROCESS_OUTPUT_BYTES) { interrupt('output_limit'); return; }
          sizes[name] += chunk.length;
          chunks[name].push(chunk);
        });
      }
      // Includes process exit AND pipe completion, not just a child's exit event.
      timer = setTimer(() => interrupt('timeout'), options.timeoutMs);
    });
  };
}

export const defaultProjectsPrRunner = createBoundedProcessRunner();

/** Latch uncertainty outside the core, which may catch/normalize command results. */
export function createProcessSession(runner = defaultProjectsPrRunner) {
  let uncertain = false;
  return Object.freeze({
    canRelease: () => !uncertain,
    runner: async invocation => {
      if (uncertain) return failure('session_stopped', true);
      const result = await runner(invocation);
      if (result?.processUncertain === true) {
        uncertain = true;
        return failure('process_uncertain', true);
      }
      return result;
    }
  });
}
