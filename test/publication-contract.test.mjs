import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'integrations', 'codex', 'projects-pack-delegation');

test('public package and plugin expose one coherent beta identity', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await fs.readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, '@wornpage/projects-pr');
  assert.equal(manifest.version, '2.5.0-beta.2');
  assert.equal(plugin.name, 'projects-pack-delegation');
  assert.equal(plugin.version, manifest.version);
  assert.equal(plugin.repository, 'https://github.com/wornpage/projects-pr-machine');
  assert.equal(manifest.license, 'AGPL-3.0-only');
  assert.equal(plugin.license, manifest.license);
});

test('public source contains no private production repository link', async () => {
  const candidates = [
    'README.md',
    'docs/projects-pr.md',
    'docs/agent-trust.md',
    'integrations/codex/projects-pack-delegation/README.md',
    'integrations/codex/projects-pack-delegation/.codex-plugin/plugin.json'
  ];
  for (const candidate of candidates) {
    const source = await fs.readFile(path.join(root, candidate), 'utf8');
    assert.doesNotMatch(source, /projects-web-demo-prod/u, candidate);
  }
});

test('package binary and export resolve to the same canonical controller', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const binary = path.resolve(root, manifest.bin['projects-pr']);
  const library = path.resolve(root, manifest.exports['.']);
  await fs.access(binary);
  await fs.access(library);
  assert.ok(binary.startsWith(pluginRoot));
  assert.ok(library.startsWith(pluginRoot));
});

test('public protocol copies are bundled beside the Codex integration', async () => {
  const contract = JSON.parse(await fs.readFile(path.join(pluginRoot, 'contracts', 'wornpage-projects-tools.json'), 'utf8'));
  const handoff = JSON.parse(await fs.readFile(path.join(pluginRoot, 'contracts', 'worker-handoff.schema.json'), 'utf8'));
  assert.ok(contract);
  assert.equal(handoff.$id, 'urn:projects-local-pack-orchestrator:worker-handoff:1');
});

test('CI executes only immutable action revisions', async () => {
  const workflow = await fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const references = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)].map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const reference of references) {
    assert.match(reference, /@[0-9a-f]{40}$/u, reference);
  }
});
