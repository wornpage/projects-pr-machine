import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RELEASE_BASELINE, transitionPackMetadata, assertTransitionFixtureUnlocked } from './helpers/client-transition.mjs';
import { API_PATH, CLI_PATH } from './helpers/package-evidence.mjs';

test('client transition: lock residue refuses rollback without deleting or changing evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transition-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await assertTransitionFixtureUnlocked(root);
  const lock = path.join(root, '.git', 'projects-pr-v2.lock');
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), 'ORIGINAL');
  await assert.rejects(assertTransitionFixtureUnlocked(root), { code: 'transition_locked' });
  assert.equal(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'), 'ORIGINAL');
});

test('client transition: historical pack metadata still requires complete original entry points and digests', () => {
  const manifest = { name: '@wornpage/projects-pr', version: '2.5.0-beta.3', type: 'module',
    bin: { 'projects-pr': `./${CLI_PATH}` }, exports: { '.': `./${API_PATH}`, './cli': `./${CLI_PATH}`, './package.json': './package.json' } };
  const record = { name: manifest.name, version: manifest.version, filename: 'wornpage-projects-pr-2.5.0-beta.3.tgz',
    size: 123, shasum: 'a'.repeat(40), integrity: `sha512-${'A'.repeat(86)}==`,
    files: ['package.json', API_PATH, CLI_PATH, 'LICENSE'].map(name => ({ path: name, size: 1 })) };
  assert.deepEqual(transitionPackMetadata(JSON.stringify([record]), manifest), record);
  for (const mutate of [
    r => { r.files.pop(); }, r => { r.files.push(r.files[0]); }, r => { r.filename = '../escape.tgz'; },
    r => { r.files[0].path = '.github/leak'; }, r => { r.shasum = 'wrong'; },
    r => { r.integrity = 'wrong'; }, r => { r.size = 0; }, r => { r.files[0].size = -1; }
  ]) { const altered = structuredClone(record); mutate(altered); assert.throws(() => transitionPackMetadata(JSON.stringify([altered]), manifest)); }
});

test('readiness workflows keep PR tests read-only and hosted writes manual, source-pinned and environment-gated', async () => {
  const read = async name => (await fs.readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const transition = await read('client-transition.yml'); const hosted = await read('hosted-draft-rehearsal.yml');
  for (const workflow of [transition, hosted]) {
    for (const match of workflow.matchAll(/uses:\s*([^\s]+)/gu)) assert.match(match[1], /@[a-f0-9]{40}$/u);
    assert.doesNotMatch(workflow, /continue-on-error|pull_request_target|write-all|contents: write|pull-requests: write/u);
    assert.match(workflow, /persist-credentials: false/u);
  }
  assert.match(transition, new RegExp(`ref: ${RELEASE_BASELINE}`, 'u'));
  assert.match(transition, /npm run check:transition -- \.\.\/baseline/u);
  assert.match(transition, /os: \[ubuntu-latest, windows-latest\]/u);
  assert.match(transition, /node: \[22, 24\]/u); assert.match(transition, /os: macos-latest/u);
  assert.doesNotMatch(transition, /secrets\.|environment:|rehearse:hosted/u);
  assert.match(hosted, /on:\n  workflow_dispatch:/u);
  assert.doesNotMatch(hosted, /\n  (pull_request|push|schedule|workflow_run):/u);
  assert.match(hosted, /github\.event\.repository\.default_branch/u);
  assert.match(hosted, /environment: projects-pr-hosted-rehearsal/u);
  assert.match(hosted, /ref: \$\{\{ github.sha \}\}/u);
  assert.match(hosted, /REHEARSAL_CONFIRM_REPOSITORY: \$\{\{ inputs.confirm_repository \}\}/u);
  assert.match(hosted, /if-no-files-found: error/u);
  assert.doesNotMatch(hosted, /run:.*\$\{\{ inputs\./u);
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['check:transition'], 'node test/client-transition.mjs');
  assert.equal(pkg.scripts['rehearse:hosted'], 'node scripts/hosted-draft-rehearsal.mjs');
  assert.equal(pkg.scripts.check, 'npm test && npm run check:package');
});
