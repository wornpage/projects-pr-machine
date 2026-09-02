#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECTS_PR_SCHEMA_VERSION,
  ProjectsPrError,
  abortProjectsPr,
  finalizeProjectsPr,
  prepareProjectsPr,
  runProjectsPrDoctor,
  stackProjectsPr,
  statusProjectsPr
} from './lib/projects-pr.mjs';

const HELP = `projects-pr v2

Prepare and finalize reviewed, low-energy Projects workers as draft PRs.
Optionally link two or more completed drafts into GitHub's public-preview stack.
There is no one-shot worker-command mode and this controller never merges.

Usage:
  projects-pr doctor [--repo PATH] [--base BRANCH] [--remote NAME] [--stack]
  projects-pr prepare --pack-id ID --title TEXT --base BRANCH \\
    --verify-command COMMAND [--repo PATH] [--remote NAME]
  projects-pr status --pack-id ID [--repo PATH]
  projects-pr finalize --pack-id ID [--repo PATH]
  projects-pr stack --pack-id BOTTOM --pack-id NEXT [--pack-id TOP ...] \\
    --base BRANCH [--repo PATH] [--remote NAME]
  projects-pr abort --pack-id ID [--repo PATH]

Lifecycle:
  doctor    Read-only capability, repository, remote, and GitHub checks.
  prepare   Create the exact isolated branch/worktree and resumable state.
  status    Observe local, remote, worktree, and PR state without mutation.
  finalize  Verify, push the exact ref, create/verify a draft PR, and clean up.
  stack     Link completed drafts bottom-to-top with official github/gh-stack.
  abort     Remove only an unchanged, unpushed prepared worktree and branch.

Options:
  --repo PATH              Git top-level checkout (default: current directory)
  --pack-id ID             Delegated Projects child pack identifier
                           Repeat in bottom-to-top order for stack
  --title TEXT             Draft pull request title
  --base BRANCH            Clean, currently checked-out base branch
  --remote NAME            Git remote (default: origin)
  --verify-command COMMAND Fixed command stored at prepare and run at finalize
  --stack                   Require official github/gh-stack capability in doctor
  --help                    Show this help
`;

const COMMAND_OPTIONS = Object.freeze({
  doctor: new Map([
    ['--repo', 'repositoryRoot'],
    ['--base', 'baseBranch'],
    ['--remote', 'remote'],
    ['--stack', 'stack']
  ]),
  prepare: new Map([
    ['--pack-id', 'packId'],
    ['--title', 'title'],
    ['--base', 'baseBranch'],
    ['--verify-command', 'verificationCommand'],
    ['--repo', 'repositoryRoot'],
    ['--remote', 'remote']
  ]),
  status: new Map([
    ['--pack-id', 'packId'],
    ['--repo', 'repositoryRoot']
  ]),
  finalize: new Map([
    ['--pack-id', 'packId'],
    ['--repo', 'repositoryRoot']
  ]),
  stack: new Map([
    ['--pack-id', 'packIds'],
    ['--base', 'baseBranch'],
    ['--repo', 'repositoryRoot'],
    ['--remote', 'remote']
  ]),
  abort: new Map([
    ['--pack-id', 'packId'],
    ['--repo', 'repositoryRoot']
  ])
});

export function parseProjectsPrArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') return { help: true };
  const command = argv[0];
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new ProjectsPrError(`Unknown command: ${command}`, { code: 'invalid_input' });
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    const field = allowed.get(argument);
    if (!field) throw new ProjectsPrError(`Unknown option for ${command}: ${argument}`, { code: 'invalid_input' });
    if (field === 'stack') {
      if (options.stack === true) {
        throw new ProjectsPrError(`${argument} may be supplied only once.`, { code: 'invalid_input' });
      }
      options.stack = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ProjectsPrError(`${argument} requires a value.`, { code: 'invalid_input' });
    }
    if (field === 'packIds') {
      options.packIds ??= [];
      options.packIds.push(value);
      index += 1;
      continue;
    }
    if (Object.hasOwn(options, field)) {
      throw new ProjectsPrError(`${argument} may be supplied only once.`, { code: 'invalid_input' });
    }
    options[field] = value;
    index += 1;
  }
  options.repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  return options;
}

export async function main(argv = process.argv.slice(2), io = console, dependencies = {}) {
  let options = null;
  try {
    options = parseProjectsPrArgs(argv);
    if (options.help) {
      io.log(HELP);
      return 0;
    }
    let receipt;
    if (options.command === 'doctor') receipt = await runProjectsPrDoctor(options, dependencies);
    if (options.command === 'prepare') receipt = await prepareProjectsPr(options, dependencies);
    if (options.command === 'status') receipt = await statusProjectsPr(options, dependencies);
    if (options.command === 'finalize') receipt = await finalizeProjectsPr(options, dependencies);
    if (options.command === 'stack') receipt = await stackProjectsPr(options, dependencies);
    if (options.command === 'abort') receipt = await abortProjectsPr(options, dependencies);
    io.log(JSON.stringify(receipt, null, 2));
    return receipt.status === 'unavailable' ? 2 : 0;
  } catch (error) {
    const failure = error instanceof ProjectsPrError
      ? error
      : new ProjectsPrError('projects-pr failed.');
    io.error(JSON.stringify(failure.receipt ?? {
      schemaVersion: PROJECTS_PR_SCHEMA_VERSION,
      kind: 'projects-pr',
      command: options?.command ?? (COMMAND_OPTIONS[argv[0]] ? argv[0] : null),
      status: 'failed',
      error: { code: failure.code, message: failure.message, exitCode: failure.exitCode },
      recovery: {
        nextCommand: 'doctor',
        args: options?.repositoryRoot ? ['--repo', options.repositoryRoot] : []
      }
    }, null, 2));
    return 1;
  }
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) process.exitCode = await main();
