import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  const packedCli = path.join(temp, 'node_modules', '@wornpage', 'projects-pr', 'integrations', 'codex', 'projects-pack-delegation', 'skills', 'projects-pack-delegation', 'scripts', 'projects-pr.mjs');
  const help = execFileSync(process.execPath, [packedCli, '--help'], {
    cwd: temp, encoding: 'utf8'
  });
  assert.match(help, /projects-pr v2/u);
  assert.match(help, /authorize-admin/u);
  assert.match(help, /finish/u);
  for (const command of ['authorize', 'authorize-admin', 'finish']) {
    const commandHelp = execFileSync(process.execPath, [packedCli, command, '--help'], {
      cwd: temp, encoding: 'utf8'
    });
    assert.match(commandHelp, /projects-pr v2/u);
    const guarded = spawnSync(process.execPath, [packedCli, command], {
      cwd: temp, encoding: 'utf8'
    });
    assert.equal(guarded.status, 1, command);
    const failure = JSON.parse(guarded.stderr);
    assert.equal(failure.command, command);
    assert.equal(failure.error.code, 'invalid_input');
  }
  const imported = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "import('@wornpage/projects-pr').then((m) => console.log([m.runProjectsPrDoctor,m.authorizeProjectsPr,m.authorizeAdminProjectsPr,m.finishProjectsPr].map((v)=>typeof v).join(',')))"
  ], { cwd: temp, encoding: 'utf8' }).trim();
  assert.equal(imported, 'function,function,function,function');
  fs.rmSync(path.join(root, tarball), { force: true });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('package contract passed');
