import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  defaultProjectsPrRunner, runProjectsPrDoctor
} from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/projects-pr.mjs';

test('public doctor executes its real platform shell probe through the bounded runner', { timeout: 15_000 }, async () => {
  const probes = [];
  const receipt = await runProjectsPrDoctor({ repositoryRoot: tmpdir() }, {
    nodeVersion: '22.0.0',
    runner: async invocation => {
      // Refuse Git/GitHub in this fixture: only the real local shell is exercised.
      if (invocation.executable === 'git' || invocation.executable === 'gh') {
        return { exitCode: 127, stdout: '', stderr: '' };
      }
      probes.push(invocation);
      return defaultProjectsPrRunner({ ...invocation, timeoutMs: 5_000 });
    }
  });
  assert.equal(probes.length, 1);
  assert.equal(probes[0].executable, process.platform === 'win32' ? 'pwsh' : '/bin/sh');
  assert.equal(probes[0].shell, false);
  const shell = receipt.capability.checks.find(check => check.id === 'shell');
  assert.equal(shell.passed, true); assert.equal(shell.exitCode, 0);
  assert.equal(receipt.status, 'unavailable'); // Missing Git/GitHub still deny capability.
});
