import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'run this contract through npm so npm_execpath is available');

function npm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], options);
}

const packJson = JSON.parse(npm(['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8'
}));
assert.equal(packJson.length, 1);
const names = new Set(packJson[0].files.map((file) => file.path.replaceAll('\\', '/')));
for (const required of [
  'README.md',
  'LICENSE',
  'docs/projects-pr.md',
  'integrations/codex/projects-pack-delegation/.codex-plugin/plugin.json',
  'integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs',
  'integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs'
]) assert.equal(names.has(required), true, `packed file missing: ${required}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wornpage-projects-pr-package-'));
try {
  const tarball = npm(['pack', '--silent'], {
    cwd: root,
    encoding: 'utf8'
  }).trim().split(/\r?\n/u).at(-1);
  npm(['init', '--yes'], { cwd: temp, stdio: 'ignore' });
  npm(['install', '--ignore-scripts', path.join(root, tarball)], {
    cwd: temp,
    stdio: 'ignore'
  });
  const help = execFileSync(process.execPath, [
    path.join(temp, 'node_modules', '@wornpage', 'projects-pr', 'integrations', 'codex', 'projects-pack-delegation', 'skills', 'projects-pack-delegation', 'scripts', 'projects-pr.mjs'),
    '--help'
  ], { cwd: temp, encoding: 'utf8' });
  assert.match(help, /projects-pr v2/u);
  const imported = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "import('@wornpage/projects-pr').then((m) => console.log(typeof m.runProjectsPrDoctor))"
  ], { cwd: temp, encoding: 'utf8' }).trim();
  assert.equal(imported, 'function');
  fs.rmSync(path.join(root, tarball), { force: true });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('package contract passed');
