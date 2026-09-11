// Deliberately invokes the real parser/dispatcher, not the binary's no-injection bootstrap.
import { main } from '../../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/projects-pr.mjs';
import { openFixture } from './local-delivery-harness.mjs';
const [directory, ...argv] = process.argv.slice(2);
const fixture = await openFixture(directory);
await fixture.audit('cli-start', { command: argv[0] });
process.exitCode = await main(argv, console, { runner: fixture.runner });
