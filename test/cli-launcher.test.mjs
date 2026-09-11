import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { CLI_PATH, packageEnvironment, assertFailureReceipt } from './helpers/package-evidence.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, CLI_PATH);
const cliUrl = JSON.stringify(pathToFileURL(cli).href);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-launcher-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const alias = path.join(directory, 'linked scripts');
  // Directory junctions exercise path aliasing without Windows file-symlink privileges.
  await fs.symlink(path.dirname(cli), alias, 'junction');
  return { directory, alias: path.join(alias, 'projects-pr.mjs') };
}
async function run(args, cwd) {
  try {
    const result = await execute(process.execPath, args, { cwd, env: packageEnvironment(cwd),
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
    return { exitCode: 0, ...result };
  } catch (error) {
    assert.ok(!error.killed && !error.signal && Number.isInteger(error.code), 'probe did not complete normally');
    return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('CLI bootstrap: direct invocation prints help once', async t => {
  const { directory } = await fixture(t);
  const result = await run([cli, '--help'], directory);
  assert.equal(result.exitCode, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout.match(/projects-pr v2/gu)?.length, 1);
});

test('CLI bootstrap: directory alias executes the same help rather than silently exiting', async t => {
  const { directory, alias } = await fixture(t);
  const direct = await run([cli, '--help'], directory);
  const linked = await run([alias, '--help'], directory);
  assert.match(direct.stdout, /projects-pr v2/u);
  assert.deepEqual(linked, direct);
});

test('CLI bootstrap: aliased invocation preserves nonzero invalid-input receipts', async t => {
  const { directory, alias } = await fixture(t);
  assertFailureReceipt(await run([alias, 'finalize', '--force-unlock'], directory), 'finalize', 'invalid_input');
});

test('CLI bootstrap: a different entry file with the same basename only imports the module', async t => {
  const { directory } = await fixture(t);
  const importer = path.join(directory, 'projects-pr.mjs');
  await fs.writeFile(importer, `await import(${cliUrl}); console.log('import-only');\n`);
  assert.deepEqual(await run([importer], directory), { exitCode: 0, stdout: 'import-only\n', stderr: '' });
});

test('CLI bootstrap: evaluation without an entry pathname has no implicit main call', async t => {
  const { directory } = await fixture(t);
  const result = await run(['--input-type=module', '--eval', `await import(${cliUrl}); console.log('import-only');`], directory);
  assert.deepEqual(result, { exitCode: 0, stdout: 'import-only\n', stderr: '' });
});

test('CLI bootstrap: unresolved evaluation argv is not an error or authority to execute', async t => {
  const { directory } = await fixture(t);
  const result = await run(['--input-type=module', '--eval', `await import(${cliUrl}); console.log('import-only');`,
    path.join(directory, 'missing-entry.mjs')], directory);
  assert.deepEqual(result, { exitCode: 0, stdout: 'import-only\n', stderr: '' });
});
