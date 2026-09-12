import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { API_PATH, CLI_PATH, packagePath, validateManifest } from './package-evidence.mjs';

// Peeled v2.5.0-beta.3 release tag, not a moving branch or an npm dist-tag.
export const RELEASE_BASELINE = '101c870e3f80b504a91b45881831e5b906896d2e';
export function transitionPackMetadata(raw, manifest) {
  validateManifest(manifest);
  const records = JSON.parse(raw);
  assert.ok(Array.isArray(records) && records.length === 1, 'one transition artifact');
  const record = records[0];
  assert.equal(record.name, manifest.name); assert.equal(record.version, manifest.version);
  assert.equal(record.filename, `wornpage-projects-pr-${manifest.version}.tgz`);
  assert.match(record.shasum, /^[a-f0-9]{40}$/u); assert.match(record.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
  assert.ok(Number.isSafeInteger(record.size) && record.size > 0 && record.size <= 16777216);
  assert.ok(Array.isArray(record.files) && record.files.length > 0 && record.files.length <= 2000);
  const names = new Set();
  for (const file of record.files) {
    packagePath(file.path); assert.ok(!names.has(file.path)); names.add(file.path);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 4194304);
  }
  // Baseline predates locks/review helpers. Both artifacts must expose the real
  // original CLI/API; the candidate's existing package contract checks new assets.
  for (const name of ['package.json', CLI_PATH, API_PATH, 'LICENSE']) assert.ok(names.has(name));
  return record;
}
export async function assertTransitionFixtureUnlocked(repository) {
  // For the test's top-level disposable checkout only; NOT a production updater
  // or proof that arbitrary old clients/background processes are quiescent.
  assert.ok((await fs.lstat(path.join(repository, '.git'))).isDirectory());
  try { await fs.lstat(path.join(repository, '.git', 'projects-pr-v2.lock')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const error = new Error('Transition refused while lifecycle lock evidence exists.');
  error.code = 'transition_locked'; throw error;
}
