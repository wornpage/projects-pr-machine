import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openFixture } from './local-delivery-harness.mjs';
import { withRepositoryLifecycleLock }
  from '../../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/repository-lock.mjs';

// Test-owned installed artifact and fixture only. GitHub is a strict stand-in.
const [directory, cli, mode] = process.argv.slice(2);
if (!['baseline-prepare', 'status', 'locked-finalize'].includes(mode)) throw Error('invalid_transition_probe');
const f = await openFixture(directory);
const { main } = await import(pathToFileURL(cli));
const argv = [mode === 'baseline-prepare' ? 'prepare' : mode === 'status' ? 'status' : 'finalize',
  '--repo', f.root, '--pack-id', 'rehearsal'];
if (mode === 'baseline-prepare') {
  argv.push('--title', 'Local lifecycle', '--base', 'main', '--verify-command', 'node verify.mjs');
  // The release predates lifecycle locking. Serialize only this disposable
  // preparation externally so the strict local transport can verify ownership.
  process.exitCode = await withRepositoryLifecycleLock(f.root,
    () => main(argv, console, { runner: f.runner }), { runner: f.runner });
} else {
  if (mode === 'locked-finalize') await fs.lstat(f.lock);
  process.exitCode = await main(argv, console, { runner: f.runner });
}
