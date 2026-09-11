import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  API_PATH, CLI_PATH, REQUIRED_FILES, digest, packageEnvironment, validateManifest,
  packagePath, npmArguments, validatePackMetadata, verifyTarball, regularBytes,
  verifyInstalledBytes, installedInventory, assertFailureReceipt
} from './helpers/package-evidence.mjs';

function manifest() {
  return { name: '@wornpage/projects-pr', version: '2.5.0-beta.3', type: 'module',
    bin: { 'projects-pr': `./${CLI_PATH}` },
    exports: { '.': `./${API_PATH}`, './cli': `./${CLI_PATH}`, './package.json': './package.json' } };
}
function metadata() {
  const bytes = Buffer.from('synthetic tarball bytes; not a controller artifact');
  return { bytes, record: { name: manifest().name, version: manifest().version,
    filename: 'wornpage-projects-pr-2.5.0-beta.3.tgz', size: bytes.length,
    shasum: digest(bytes, 'sha1'), integrity: `sha512-${digest(bytes, 'sha512', 'base64')}`,
    files: REQUIRED_FILES.map(name => ({ path: name, size: 1 })) } };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('package evidence: reduced environment excludes secrets and executable/config injection', () => {
  const home = path.resolve('test-home');
  const env = packageEnvironment(home, { PATH: 'tools', SYSTEMROOT: 'system',
    NPM_TOKEN: 'secret', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', NODE_AUTH_TOKEN: 'secret',
    NODE_OPTIONS: '--import=untrusted', NODE_PATH: 'untrusted', GIT_DIR: 'elsewhere',
    GIT_CONFIG_COUNT: '1', GIT_TRACE: 'trace', npm_config_registry: 'untrusted',
    HTTP_PROXY: 'secret', SSH_AUTH_SOCK: 'secret', HOME: 'original', USERPROFILE: 'original' });
  for (const key of ['NPM_TOKEN','GH_TOKEN','GITHUB_TOKEN','NODE_AUTH_TOKEN','NODE_OPTIONS','NODE_PATH',
    'GIT_DIR','GIT_CONFIG_COUNT','GIT_TRACE','npm_config_registry','HTTP_PROXY','SSH_AUTH_SOCK']) {
    assert.equal(Object.hasOwn(env, key), false, key);
  }
  assert.equal(env.HOME, home); assert.equal(env.USERPROFILE, home);
  assert.equal(env.GIT_ALLOW_PROTOCOL, ''); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
});

test('package evidence: environment key casing supports Windows without forwarding mixed-case secrets', () => {
  const env = packageEnvironment(path.resolve('home'), { Path: 'tools', SystemRoot: 'windows',
    ComSpec: 'cmd.exe', PathExt: '.EXE;.CMD', Temp: 'temp', nPm_ToKeN: 'secret', Git_Dir: 'wrong' });
  assert.equal(env.SystemRoot, 'windows'); assert.equal(env.Temp, 'temp');
  assert.equal(Object.hasOwn(env, 'PATH'), false);
  assert.equal(env.Path.split(path.delimiter)[0], path.dirname(process.execPath));
  assert.equal(Object.hasOwn(env, 'nPm_ToKeN'), false); assert.equal(Object.hasOwn(env, 'Git_Dir'), false);
});

test('package evidence: exact public entry points and dependency-free identity are required', () => {
  validateManifest(manifest());
  for (const mutate of [m => { m.name = '@other/package'; }, m => { m.version = '../escape'; },
    m => { m.type = 'commonjs'; }, m => { m.bin['projects-pr'] = './other.mjs'; },
    m => { m.exports['.'] = './core.mjs'; }, m => { m.exports['./private'] = './core.mjs'; },
    m => { m.dependencies = { unexpected: '*' }; }, m => { m.optionalDependencies = { unexpected: '*' }; },
    m => { m.peerDependencies = { unexpected: '*' }; }, m => { m.bundledDependencies = true; }]) {
    const m = manifest(); mutate(m); assert.throws(() => validateManifest(m));
  }
});

test('package evidence: one exact artifact and immutable digest metadata are accepted', () => {
  const { bytes, record } = metadata();
  assert.deepEqual(validatePackMetadata(JSON.stringify([record]), manifest()), record);
  assert.equal(verifyTarball(bytes, record), digest(bytes));
});

for (const name of REQUIRED_FILES) {
  test(`package evidence: required asset cannot disappear (${name})`, () => {
    const { record } = metadata(); record.files = record.files.filter(file => file.path !== name);
    assert.throws(() => validatePackMetadata(JSON.stringify([record]), manifest()));
  });
}

test('package evidence: empty, multiple, malformed, or wrong-identity pack receipts fail', () => {
  const { record } = metadata();
  for (const raw of ['null', '{}', '[]', '{', JSON.stringify([record, record])]) {
    assert.throws(() => validatePackMetadata(raw, manifest()));
  }
  for (const [key, value] of [['name', '@wrong/package'], ['version','2.0.0'],
    ['filename','../artifact.tgz'], ['shasum','a'], ['integrity','sha1-abc'],
    ['size',0], ['size',17 * 1024 * 1024], ['size',1.5], ['files',null]]) {
    assert.throws(() => validatePackMetadata(JSON.stringify([{ ...record, [key]: value }]), manifest()));
  }
});

test('package evidence: duplicate entries and malformed file sizes cannot pass', () => {
  const { record } = metadata();
  assert.throws(() => validatePackMetadata(JSON.stringify([{ ...record, files: [...record.files, record.files[0]] }]), manifest()));
  for (const size of [-1, '1', null, 1.5, 5 * 1024 * 1024]) {
    const changed = structuredClone(record); changed.files[0].size = size;
    assert.throws(() => validatePackMetadata(JSON.stringify([changed]), manifest()));
  }
});

test('package evidence: paths cannot escape, alias, traverse dependencies, or leak test/config/archive files', () => {
  for (const name of ['', '/absolute', '../outside', 'a/../../outside', 'a//b', './README.md',
    'a/./b', 'C:/outside', 'a\\b', 'a\0b', 'a\nb', 'a/', '.git/config', 'a/.GIT/config',
    'node_modules/a', 'a/node_modules/b', 'test/private.mjs', 'tests/private.mjs',
    '.github/workflows/ci.yml', '.npmrc', 'artifact.tgz']) {
    assert.throws(() => packagePath(name));
  }
  assert.deepEqual(packagePath(CLI_PATH), CLI_PATH.split('/'));
  assert.deepEqual(packagePath('docs/test-plan.md'), ['docs', 'test-plan.md']);
});

test('package evidence: corrupted tarball, size, SHA-1, and SHA-512 are independently rejected', () => {
  const { bytes, record } = metadata();
  const corrupted = Buffer.from(bytes); corrupted[0] ^= 1;
  assert.throws(() => verifyTarball(corrupted, record));
  for (const change of [{ size: bytes.length + 1 }, { shasum: '0'.repeat(40) },
    { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }]) {
    assert.throws(() => verifyTarball(bytes, { ...record, ...change }));
  }
});

test('package evidence: unchanged installed bytes pass; code and JSON changes do not', () => {
  for (const name of [CLI_PATH, API_PATH, 'package.json', 'docs/projects-pr.md']) {
    const bytes = Buffer.from('ordinary original bytes\r\n');
    assert.equal(verifyInstalledBytes(bytes, Buffer.from(bytes), name), false);
    assert.throws(() => verifyInstalledBytes(bytes, Buffer.from('different bytes\r\n'), name));
    assert.throws(() => verifyInstalledBytes(bytes, Buffer.from('ordinary original bytes\n'), name));
  }
});

test('package evidence: only the executable shebang CRLF normalization is allowed', () => {
  const source = Buffer.from('#!/usr/bin/env node\r\nconsole.log("original");\r\n');
  const canonical = Buffer.from('#!/usr/bin/env node\nconsole.log("original");\r\n');
  assert.equal(verifyInstalledBytes(source, canonical, CLI_PATH), true);
  assert.throws(() => verifyInstalledBytes(source, canonical, API_PATH));
  assert.throws(() => verifyInstalledBytes(source, Buffer.from(source.toString().replaceAll('\r\n', '\n')), CLI_PATH));
  assert.throws(() => verifyInstalledBytes(source, Buffer.from(canonical.toString().replace('original','changed')), CLI_PATH));
});

test('package evidence: regular-file reads and inventory verify actual bytes, not only filenames', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'README.md'), 'original');
  await fs.writeFile(path.join(root, 'docs', 'usage.md'), 'usage');
  assert.deepEqual(await regularBytes(root, 'README.md'), Buffer.from('original'));
  assert.deepEqual(await installedInventory(root), ['README.md', 'docs/usage.md']);
  await assert.rejects(regularBytes(root, '../outside'));
  await assert.rejects(regularBytes(root, 'docs'));
  await assert.rejects(regularBytes(root, 'missing.md'), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'README.md'), 'modified');
  assert.throws(() => verifyInstalledBytes(Buffer.from('original'), Buffer.from('modified'), 'README.md'));
});

test('package evidence: directory junctions cannot redirect reads or installed inventory', async t => {
  const parent = await fixture(t); const root = path.join(parent, 'root'); const outside = path.join(parent, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret'), 'marker');
  await fs.symlink(outside, path.join(root, 'redirect'), 'junction');
  await assert.rejects(regularBytes(root, 'redirect/secret'));
  await assert.rejects(installedInventory(root));
  await assert.rejects(regularBytes(path.join(root, 'redirect'), 'secret'));
  assert.equal(await fs.readFile(path.join(outside, 'secret'), 'utf8'), 'marker');
});

test('package evidence: leaked test files are rejected during actual installed inventory', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, 'test'));
  await fs.writeFile(path.join(root, 'test', 'fixture.mjs'), 'unexpected');
  await assert.rejects(installedInventory(root));
});

test('package evidence: failed CLI receipt needs nonzero status, no stdout, and exact command/error', () => {
  const receipt = { schemaVersion: 2, kind: 'projects-pr', command: 'finalize', status: 'failed',
    error: { code: 'lifecycle_locked' } };
  const result = { exitCode: 1, stdout: '', stderr: JSON.stringify(receipt) };
  assert.deepEqual(assertFailureReceipt(result, 'finalize', 'lifecycle_locked'), receipt);
  for (const changed of [{ ...result, exitCode: 0 }, { ...result, stdout: 'success' },
    { ...result, stderr: 'invalid JSON' }, { ...result, stderr: `${result.stderr}\n${result.stderr}` }]) {
    assert.throws(() => assertFailureReceipt(changed, 'finalize', 'lifecycle_locked'));
  }
  for (const changed of [{ schemaVersion: 1 }, { kind: 'other' }, { command: 'prepare' },
    { status: 'completed' }, { error: { code: 'invalid_input' } }]) {
    assert.throws(() => assertFailureReceipt({ ...result, stderr: JSON.stringify({ ...receipt, ...changed }) },
      'finalize', 'lifecycle_locked'));
  }
});


test('package evidence: actual npm argument builder isolates config/cache and forbids online side effects', () => {
  const home = path.resolve('isolated-home'); const original = ['pack', '--json'];
  const args = npmArguments(original, home);
  assert.deepEqual(original, ['pack', '--json']);
  assert.deepEqual(args, ['pack','--json','--offline','--ignore-scripts','--no-audit','--no-fund','--workspaces=false',
    '--cache',path.join(home,'cache'),'--userconfig',path.join(home,'user.npmrc'),
    '--globalconfig',path.join(home,'global.npmrc'),'--registry=http://127.0.0.1:9']);
  assert.equal(npmArguments(['install', 'local.tgz'], home)[0], 'install');
  for (const bad of [null, [], ['publish'], ['exec'], ['install', 1]]) {
    assert.throws(() => npmArguments(bad, home));
  }
});

test('package evidence: shebang handling cannot silently re-encode arbitrary body bytes', () => {
  const source = Buffer.concat([Buffer.from('#!/usr/bin/env node\r\n'), Buffer.from([255, 254])]);
  const changed = Buffer.from(source.toString('utf8').replace('\r\n', '\n'));
  assert.throws(() => verifyInstalledBytes(source, changed, CLI_PATH));
  const exact = Buffer.concat([Buffer.from('#!/usr/bin/env node\n'), Buffer.from([255, 254])]);
  assert.equal(verifyInstalledBytes(source, exact, CLI_PATH), true);
});
