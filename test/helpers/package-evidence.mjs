import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const integration = 'integrations/codex/projects-pack-delegation';
export const SCRIPTS_PATH = `${integration}/skills/projects-pack-delegation/scripts`;
export const CLI_PATH = `${SCRIPTS_PATH}/projects-pr.mjs`;
export const API_PATH = `${SCRIPTS_PATH}/lib/projects-pr.mjs`;
export const REQUIRED_FILES = Object.freeze([
  'package.json', 'README.md', 'LICENSE', 'docs/projects-pr.md',
  `${integration}/.codex-plugin/plugin.json`, CLI_PATH, API_PATH,
  `${SCRIPTS_PATH}/lib/projects-pr-core.mjs`,
  `${SCRIPTS_PATH}/lib/repository-lock.mjs`, `${SCRIPTS_PATH}/lib/bounded-process.mjs`,
  `${SCRIPTS_PATH}/code-review-snapshot.mjs`, `${SCRIPTS_PATH}/code-review-report.mjs`,
  `${integration}/contracts/code-handoff-acceptance.mjs`,
  `${integration}/contracts/worker-handoff.schema.json`
]);
export const digest = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);

// Git reports canonical checkout paths, including Windows long path spellings.
export async function createPackageWorkspace(parent) {
  return fs.realpath(await fs.mkdtemp(path.join(parent, 'wornpage-package-contract-')));
}

export function packageEnvironment(home, inherited = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TMP|TEMP)$/iu.test(key)) env[key] = value;
  }
  // Use the current Node for npm and the installed command's env-node shebang.
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${env[pathKey] ?? ''}`;
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, APPDATA: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C'
  });
}

export function npmArguments(args, home) {
  assert.ok(Array.isArray(args) && ['pack', 'install'].includes(args[0])
    && args.every(value => typeof value === 'string'), 'only local pack/install operations');
  return [...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false',
    '--cache', path.join(home, 'cache'), '--userconfig', path.join(home, 'user.npmrc'),
    '--globalconfig', path.join(home, 'global.npmrc'), '--registry=http://127.0.0.1:9'];
}

export function validateManifest(manifest) {
  assert.equal(manifest?.name, '@wornpage/projects-pr', 'package identity');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u, 'package version');
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.bin, { 'projects-pr': `./${CLI_PATH}` });
  assert.deepEqual(manifest.exports, {
    '.': `./${API_PATH}`, './cli': `./${CLI_PATH}`, './package.json': './package.json'
  });
  // Introducing dependencies requires deliberately revisiting this offline contract.
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = manifest[field];
    assert.ok(value === undefined || (value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 0), 'dependency-free artifact');
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    assert.ok(manifest[field] === undefined || (Array.isArray(manifest[field]) && !manifest[field].length),
      'no bundled dependencies');
  }
}

export function packagePath(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 1000,
    'invalid package path');
  assert.ok(!/[\\:\u0000-\u001f\u007f]/u.test(value), 'invalid package path');
  const parts = value.split('/');
  assert.ok(parts.every(part => part && part !== '.' && part !== '..'
    && !['.git', 'node_modules'].includes(part.toLowerCase())), 'invalid package path');
  assert.ok(!['test', 'tests', '.github', '.npmrc'].includes(parts[0].toLowerCase())
    && !value.toLowerCase().endsWith('.tgz'), 'test/config/archive leaked into package');
  return parts;
}

export function validatePackMetadata(raw, manifest) {
  validateManifest(manifest);
  const records = JSON.parse(raw);
  assert.ok(Array.isArray(records) && records.length === 1, 'one packed artifact required');
  const record = records[0];
  assert.equal(record.name, manifest.name);
  assert.equal(record.version, manifest.version);
  assert.equal(record.filename, `wornpage-projects-pr-${manifest.version}.tgz`);
  assert.match(record.shasum, /^[0-9a-f]{40}$/u);
  assert.match(record.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
  assert.ok(Number.isSafeInteger(record.size) && record.size > 0 && record.size <= 16 * 1024 * 1024);
  assert.ok(Array.isArray(record.files) && record.files.length > 0 && record.files.length <= 2000);
  const names = new Set();
  for (const item of record.files) {
    packagePath(item.path);
    assert.ok(!names.has(item.path), 'duplicate package path');
    names.add(item.path);
    assert.ok(Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= 4 * 1024 * 1024);
  }
  for (const name of REQUIRED_FILES) assert.ok(names.has(name), 'required package file missing');
  return record;
}

export function verifyTarball(bytes, record) {
  assert.ok(Buffer.isBuffer(bytes), 'tarball bytes required');
  assert.equal(bytes.length, record.size, 'tarball size');
  assert.equal(digest(bytes, 'sha1'), record.shasum, 'tarball SHA-1');
  assert.equal(`sha512-${digest(bytes, 'sha512', 'base64')}`, record.integrity, 'tarball SHA-512');
  return digest(bytes);
}

export async function regularBytes(root, relative) {
  const parts = packagePath(relative);
  let target = root;
  assert.ok((await fs.lstat(target)).isDirectory(), 'package root must be a real directory');
  for (let index = 0; index < parts.length; index += 1) {
    target = path.join(target, parts[index]);
    const stat = await fs.lstat(target);
    assert.ok(!stat.isSymbolicLink(), 'package paths cannot traverse links');
    assert.ok(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), 'package path kind');
    assert.ok(stat.size <= 4 * 1024 * 1024, 'package file too large');
  }
  return fs.readFile(target);
}

export function verifyInstalledBytes(source, installed, name) {
  assert.ok(Buffer.isBuffer(source) && Buffer.isBuffer(installed));
  if (source.equals(installed)) return false;
  // npm bin-links removes only CR from a CRLF shebang. Never normalize other code.
  const newline = source.indexOf(10);
  if (name === CLI_PATH && source[0] === 35 && source[1] === 33 && newline > 2
      && source[newline - 1] === 13) {
    const canonical = Buffer.concat([source.subarray(0, newline - 1), source.subarray(newline)]);
    if (canonical.equals(installed)) return true;
  }
  assert.fail('installed bytes differ from source');
}

export async function installedInventory(root) {
  const names = [];
  async function visit(directory, prefix = '') {
    assert.ok((await fs.lstat(directory)).isDirectory(), 'installed directory is not real');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      packagePath(name);
      assert.ok(!entry.isSymbolicLink(), 'installed links are forbidden');
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), `${name}/`);
      else { assert.ok(entry.isFile(), 'unexpected installed file kind'); names.push(name); }
    }
  }
  await visit(root);
  return names.sort();
}

export function assertFailureReceipt(result, command, code) {
  assert.equal(result.exitCode, 1, 'CLI must fail');
  assert.equal(result.stdout, '', 'failure must not print a success receipt');
  const receipt = JSON.parse(result.stderr);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.kind, 'projects-pr');
  assert.equal(receipt.command, command);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.code, code);
  return receipt;
}
