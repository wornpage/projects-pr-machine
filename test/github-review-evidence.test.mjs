import assert from 'node:assert/strict';
import test from 'node:test';
import { readGitHubReviewEvidence, REVIEW_THREADS_QUERY }
  from '../integrations/codex/projects-pack-delegation/contracts/github-review-evidence.mjs';
import { createGitHubReadClient }
  from '../integrations/codex/projects-pack-delegation/contracts/github-read-client.mjs';

function fixture() {
  const f = { expected: { repository: 'fixture/rehearsal', number: 1, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
    reviewerIds: [22, 23], excludedIds: [11], minimumApprovals: 1 }, reads: 0, calls: [],
    reviews: [{ id: 1, user: { id: 22 }, state: 'APPROVED', commit_id: 'b'.repeat(40), submitted_at: '2026-09-11T00:00:01Z' }],
    threads: [{ id: 'T1', isResolved: true }] };
  f.pr = { number: 1, state: 'open', merged: false, user: { id: 11 },
    head: { sha: f.expected.headOid, repo: { full_name: f.expected.repository } },
    base: { sha: f.expected.baseOid, repo: { full_name: f.expected.repository } } };
  f.client = {
    async rest(resource) {
      f.calls.push(resource);
      if (resource.includes('/reviews?')) return structuredClone(f.reviews);
      f.reads++;
      if (f.reads === 2 && f.move) f.pr.head.sha = 'f'.repeat(40);
      return structuredClone(f.pr);
    },
    async graphql(query) {
      assert.equal(query, REVIEW_THREADS_QUERY);
      return { data: { repository: { pullRequest: { headRefOid: f.expected.headOid, baseRefOid: f.expected.baseOid,
        reviewThreads: { nodes: structuredClone(f.threads), pageInfo: { hasNextPage: false, endCursor: null } } } } } };
    }
  };
  return f;
}
const run = f => readGitHubReviewEvidence(f.expected, f.client);
const refuses = (f, code) => assert.rejects(run(f), e => { assert.equal(e.code, code); return true; });

test('independent review: exact allowlisted approval plus resolved threads, bracketed by PR reads', async () => {
  const f = fixture(); const receipt = await run(f);
  assert.equal(receipt.status, 'validated'); assert.deepEqual(receipt.reviewerIds, [22]);
  assert.deepEqual(receipt.reviewIds, [1]); assert.match(receipt.evidenceSha256, /^[0-9a-f]{64}$/u);
  assert.equal(f.reads, 2); assert.equal(f.calls.length, 3);
});
for (const [label, mutate, code] of [
  ['worker self-review', f => { f.reviews[0].user.id = 11; }, 'independent_review_required'],
  ['PR author even if allowlisted', f => { f.expected.reviewerIds.push(11); f.reviews[0].user.id = 11; }, 'independent_review_required'],
  ['unknown actor', f => { f.reviews[0].user.id = 90; }, 'independent_review_required'],
  ['comment-only bot review', f => { f.reviews[0].state = 'COMMENTED'; }, 'independent_review_required'],
  ['dismissed approval', f => { f.reviews[0].state = 'DISMISSED'; }, 'independent_review_required'],
  ['pending approval', f => { f.reviews[0].state = 'PENDING'; }, 'independent_review_required'],
  ['stale approval', f => { f.reviews[0].commit_id = 'f'.repeat(40); }, 'independent_review_required'],
  ['changes requested', f => { f.reviews[0].state = 'CHANGES_REQUESTED'; }, 'changes_requested'],
  ['unresolved thread', f => { f.threads[0].isResolved = false; }, 'unresolved_review_thread'],
  ['moved head after observations', f => { f.move = true; }, 'review_revision_mismatch'],
  ['wrong repository', f => { f.pr.head.repo.full_name = 'other/repository'; }, 'review_revision_mismatch'],
  ['wrong base', f => { f.pr.base.sha = 'f'.repeat(40); }, 'review_revision_mismatch'],
  ['merged PR', f => { f.pr.merged = true; }, 'review_revision_mismatch'],
  ['closed PR', f => { f.pr.state = 'closed'; }, 'review_revision_mismatch'],
  ['duplicate review', f => { f.reviews.push(structuredClone(f.reviews[0])); }, 'invalid_review_observation'],
  ['unknown state', f => { f.reviews[0].state = 'APPROVE'; }, 'invalid_review_observation'],
  ['missing submitted time', f => { f.reviews[0].submitted_at = null; }, 'invalid_review_observation'],
  ['insufficient approval count', f => { f.expected.minimumApprovals = 2; }, 'independent_review_required'],
  ['empty trusted allowlist', f => { f.expected.reviewerIds = []; }, 'invalid_review_policy'],
  ['unknown policy field', f => { f.expected.bypass = true; }, 'invalid_data']
]) test(`independent review refuses ${label}`, async () => { const f = fixture(); mutate(f); await refuses(f, code); });

test('independent review: later comment does not dismiss a request for changes', async () => {
  const f = fixture(); f.reviews[0].state = 'CHANGES_REQUESTED';
  f.reviews.push({ ...f.reviews[0], id: 2, state: 'COMMENTED', submitted_at: '2026-09-11T00:00:02Z' });
  await refuses(f, 'changes_requested');
});
test('independent review: latest submitted decision wins, not highest creation ID', async () => {
  const f = fixture(); f.reviews[0].submitted_at = '2026-09-11T00:00:03Z';
  f.reviews.push({ ...f.reviews[0], id: 2, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-11T00:00:02Z' });
  assert.equal((await run(f)).status, 'validated');
});
test('independent review: complete multi-page reviews and threads', async () => {
  const f = fixture(); const rest = f.client.rest; let pages = 0;
  f.client.rest = async resource => {
    if (!resource.includes('/reviews?')) return rest(resource);
    pages++; return pages === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...f.reviews[0], id: i + 2, state: 'COMMENTED' })) : f.reviews;
  };
  let threadPages = 0;
  f.client.graphql = async (_, variables) => {
    threadPages++; assert.equal(variables.after, threadPages === 1 ? null : 'next');
    return { data: { repository: { pullRequest: { headRefOid: f.expected.headOid, baseRefOid: f.expected.baseOid,
      reviewThreads: { nodes: [{ id: `thread-${threadPages}`, isResolved: true }],
        pageInfo: { hasNextPage: threadPages === 1, endCursor: 'next' } } } } } };
  };
  assert.equal((await run(f)).status, 'validated'); assert.equal(pages, 2); assert.equal(threadPages, 2);
});
test('independent review: pagination loops, missing collections, and GraphQL errors fail closed', async () => {
  for (const client of [
    { rest: async () => ({}) },
    { graphql: async () => ({ errors: [{ message: 'PRIVATE' }] }) },
    { graphql: async () => ({ data: { repository: { pullRequest: {
      headRefOid: 'b'.repeat(40), baseRefOid: 'a'.repeat(40), reviewThreads: {
        nodes: [], pageInfo: { hasNextPage: true, endCursor: 'loop' } } } } } }) }
  ]) {
    const f = fixture(); Object.assign(f.client, client);
    await assert.rejects(run(f), e => !String(e).includes('PRIVATE'));
  }
});
test('independent review: API exceptions are redacted, caller input captured', async () => {
  const f = fixture(); f.client.rest = async () => { throw Error('PRIVATE token'); };
  await refuses(f, 'github_observation_failed');
  const g = fixture(); const original = g.client.rest;
  g.client.rest = async resource => { const result = await original(resource); g.expected.repository = 'other/repo'; return result; };
  // Fake GraphQL must keep its original response, like the real provider.
  g.client.graphql = async () => ({ data: { repository: { pullRequest: {
    headRefOid: 'b'.repeat(40), baseRefOid: 'a'.repeat(40), reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  assert.equal((await run(g)).repository, 'fixture/rehearsal');
});

test('GitHub reader: fixed authenticated host, read-only routes and no redirects', async () => {
  const calls = []; const client = createGitHubReadClient('PRIVATE_TOKEN', { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response('{"ok":true}');
  } });
  assert.deepEqual(await client.rest('repos/fixture/rehearsal/pulls/1'), { ok: true });
  await client.graphql(REVIEW_THREADS_QUERY, { owner: 'fixture', name: 'rehearsal', number: 1, after: null });
  assert.equal(calls[0].url, 'https://api.github.com/repos/fixture/rehearsal/pulls/1');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer PRIVATE_TOKEN');
  assert.equal(calls[1].options.method, 'POST');
  for (const resource of ['https://evil.invalid/', 'repos/fixture/rehearsal/pulls/1/merge',
    'repos/../rehearsal/pulls/1', 'user', 'repos/fixture/rehearsal/pulls/1?token=PRIVATE']) {
    assert.throws(() => client.rest(resource), { code: 'github_read_scope_refused' });
  }
  assert.throws(() => client.graphql('mutation { x }', {}), { code: 'github_read_scope_refused' });
  assert.equal(calls.length, 2);
});
test('GitHub reader: failed, oversized, malformed and invalid UTF-8 responses cannot pass', async () => {
  for (const response of [new Response('PRIVATE', { status: 403 }), new Response('x'.repeat(1048577)),
    new Response('PRIVATE'), new Response(Uint8Array.of(0xff))]) {
    const client = createGitHubReadClient('PRIVATE_TOKEN', { fetchImpl: async () => response });
    await assert.rejects(client.rest('repos/fixture/rehearsal/pulls/1'), e => !String(e).includes('PRIVATE'));
  }
  assert.throws(() => createGitHubReadClient(''), { code: 'github_credentials_required' });
});
