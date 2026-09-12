import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { hostedRehearsalPolicy, verifyHostedTarget } from '../scripts/lib/hosted-rehearsal-policy.mjs';

const policy = { enabled: true, repository: 'fixture/projects-pr-rehearsal', repositoryId: 123,
  baseBranch: 'main', baseOid: 'a'.repeat(40) };
const metadata = { id: 123, full_name: policy.repository, default_branch: 'main',
  fork: false, archived: false, disabled: false, permissions: { push: true } };
const marker = { kind: 'projects-pr-disposable-rehearsal', repositoryId: 123 };

test('hosted rehearsal is disabled in checked-in configuration', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../.github/hosted-rehearsal.json', import.meta.url), 'utf8'));
  assert.throws(() => hostedRehearsalPolicy(config, policy.repository), { code: 'hosted_rehearsal_disabled' });
  assert.throws(() => hostedRehearsalPolicy({ ...policy, enabled: false }, policy.repository), { code: 'hosted_rehearsal_disabled' });
});
test('hosted rehearsal accepts only explicitly bound disposable target data', () => {
  const captured = hostedRehearsalPolicy(policy, policy.repository);
  verifyHostedTarget(captured, metadata, marker, policy.baseOid);
  assert.ok(Object.isFrozen(captured)); assert.notEqual(captured, policy);
});
for (const [label, change] of [
  ['source repository', { repository: 'wornpage/projects-pr-machine' }],
  ['frozen repository', { repository: 'wornpage/projects-webmcp-extension' }],
  ['arbitrary production repository', { repository: 'fixture/production' }],
  ['credential URL', { repository: 'https://PRIVATE@github.com/fixture/projects-pr-rehearsal' }],
  ['missing repository ID', { repositoryId: null }],
  ['moving baseline', { baseOid: 'main' }],
  ['different base branch', { baseBranch: 'production' }],
  ['extra mutation flag', { autoMerge: true }]
]) test(`hosted rehearsal refuses ${label}`, () => {
  const input = { ...policy, ...change };
  assert.throws(() => hostedRehearsalPolicy(input, input.repository));
});
test('hosted rehearsal refuses missing confirmation, target drift, reused IDs, or forged marker', () => {
  assert.throws(() => hostedRehearsalPolicy(policy, 'different'));
  for (const change of [{ id: 124 }, { full_name: 'other/projects-pr-rehearsal' }, { archived: true },
    { fork: true }, { disabled: true }, { default_branch: 'other' }, { permissions: { push: false } }]) {
    assert.throws(() => verifyHostedTarget(policy, { ...metadata, ...change }, marker, policy.baseOid));
  }
  assert.throws(() => verifyHostedTarget(policy, metadata, { ...marker, repositoryId: 124 }, policy.baseOid));
  assert.throws(() => verifyHostedTarget(policy, metadata, marker, 'b'.repeat(40)));
});

test('hosted driver uses the installed CLI and retains only bounded JSON recovery summaries', async () => {
  const source = await fs.readFile(new URL('../scripts/hosted-draft-rehearsal.mjs', import.meta.url), 'utf8');
  assert.match(source, /validatePackMetadata/u); assert.match(source, /verifyInstalledBytes/u);
  assert.match(source, /path\.join\(installed, CLI_PATH\)/u);
  assert.doesNotMatch(source, /invoke\('(finish|authorize|authorize-admin)'|git', \['push'|pr', 'merge'|--admin|--force/u);
  assert.match(source, /trace, \[\{ head: headOid \}\]/u);
  assert.match(source, /reconcileBeforeRetry: true/u);
  assert.match(source, /state-summary\.json/u);
});
