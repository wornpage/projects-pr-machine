import fs from 'node:fs/promises';
import { readGitHubReviewEvidence } from '../integrations/codex/projects-pack-delegation/contracts/github-review-evidence.mjs';
import { createGitHubReadClient } from '../integrations/codex/projects-pack-delegation/contracts/github-read-client.mjs';

// Operator-supplied policy must be trusted. Never fetch this policy from PR HEAD.
try {
  if (process.argv.length !== 3) throw Error('invalid_arguments');
  const bytes = await fs.readFile(process.argv[2]);
  if (bytes.length > 16384) throw Error('invalid_policy');
  const policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const receipt = await readGitHubReviewEvidence(policy, createGitHubReadClient(process.env.GH_TOKEN));
  console.log(JSON.stringify(receipt));
} catch (error) {
  console.error(JSON.stringify({ kind: 'github-review-evidence', status: 'refused',
    code: error?.name === 'ReadinessError' ? error.code : 'invalid_review_policy' }));
  process.exitCode = 1;
}
