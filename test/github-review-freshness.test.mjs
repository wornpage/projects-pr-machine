import assert from 'node:assert/strict';
import test from 'node:test';
import { readGitHubReviewEvidence, REVIEW_THREADS_QUERY }
  from '../integrations/codex/projects-pack-delegation/contracts/github-review-evidence.mjs';

function fixture() {
  const expected = { repository: 'fixture/read-only', number: 1, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
    reviewerIds: [22, 23], excludedIds: [11], minimumApprovals: 1 };
  const f = { expected, prReads: 0, reviewReads: 0, threadReads: 0,
    reviews: [{ id: 1, user: { id: 22 }, state: 'APPROVED', commit_id: expected.headOid,
      submitted_at: '2026-09-11T00:00:01Z' }], threads: [{ id: 'T1', isResolved: true }] };
  f.client = {
    async rest(resource) {
      if (resource.includes('/reviews?')) { f.reviewReads++; return structuredClone(f.reviews); }
      f.prReads++;
      if (f.prReads === 2) f.change?.();
      return { number: 1, state: 'open', merged: false, user: { id: 11 },
        head: { sha: expected.headOid, repo: { full_name: expected.repository } },
        base: { sha: expected.baseOid, repo: { full_name: expected.repository } } };
    },
    async graphql(query) {
      assert.equal(query, REVIEW_THREADS_QUERY); f.threadReads++;
      return { data: { repository: { pullRequest: { headRefOid: expected.headOid, baseRefOid: expected.baseOid,
        reviewThreads: { nodes: structuredClone(f.threads), pageInfo: { hasNextPage: false, endCursor: null } } } } } };
    }
  };
  return f;
}
const run = f => readGitHubReviewEvidence(f.expected, f.client);

test('review freshness: two complete equal observations bracketed by three identity reads', async () => {
  const f = fixture(); assert.equal((await run(f)).status, 'validated');
  assert.equal(f.prReads, 3); assert.equal(f.reviewReads, 2); assert.equal(f.threadReads, 2);
});
for (const [label, change, code] of [
  ['dismissal with unchanged head/base', f => { f.reviews[0].state = 'DISMISSED'; }, 'independent_review_required'],
  ['new changes request with unchanged head/base', f => { f.reviews.push({ ...f.reviews[0], id: 2,
    state: 'CHANGES_REQUESTED', submitted_at: '2026-09-11T00:00:02Z' }); }, 'changes_requested'],
  ['reopened thread with unchanged head/base', f => { f.threads[0].isResolved = false; }, 'unresolved_review_thread'],
  ['new resolved thread', f => { f.threads.push({ id: 'T2', isResolved: true }); }, 'review_state_changed'],
  ['removed resolved thread', f => { f.threads = []; }, 'review_state_changed'],
  ['replacement allowlisted approval', f => { f.reviews[0].user.id = 23; }, 'review_state_changed'],
  ['new comment', f => { f.reviews.push({ ...f.reviews[0], id: 2, state: 'COMMENTED' }); }, 'review_state_changed'],
  ['changed submitted time', f => { f.reviews[0].submitted_at = '2026-09-11T00:00:02Z'; }, 'review_state_changed']
]) test(`review freshness refuses ${label}`, async () => {
  const f = fixture(); f.change = () => change(f);
  await assert.rejects(run(f), { code });
});

test('review freshness: reread errors fail closed and do not reflect provider diagnostics', async () => {
  const f = fixture(); const rest = f.client.rest;
  f.client.rest = async resource => {
    if (f.prReads >= 2 && resource.includes('/reviews?')) throw Error('PRIVATE_TOKEN');
    return rest(resource);
  };
  await assert.rejects(run(f), e => e.code === 'github_observation_failed' && !String(e).includes('PRIVATE_TOKEN'));
});

test('review freshness: both passes collect every page from a fresh cursor', async () => {
  const f = fixture(); const rest = f.client.rest; const pages = []; const cursors = [];
  f.client.rest = async resource => {
    if (!resource.includes('/reviews?')) return rest(resource);
    const page = Number(resource.split('page=').at(-1)); pages.push(page);
    return page === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...f.reviews[0], id: i + 10, state: 'COMMENTED' })) : f.reviews;
  };
  f.client.graphql = async (_, { after }) => {
    cursors.push(after);
    return { data: { repository: { pullRequest: { headRefOid: f.expected.headOid, baseRefOid: f.expected.baseOid,
      reviewThreads: { nodes: [{ id: after ?? 'first', isResolved: true }],
        pageInfo: { hasNextPage: after === null, endCursor: after === null ? 'second' : null } } } } } };
  };
  assert.equal((await run(f)).status, 'validated');
  assert.deepEqual(pages, [1, 2, 1, 2]); assert.deepEqual(cursors, [null, 'second', null, 'second']);
});

test('review freshness: ordering alone is not semantic drift', async () => {
  const f = fixture(); f.reviews.push({ ...f.reviews[0], id: 2, state: 'COMMENTED' });
  f.threads.push({ id: 'T2', isResolved: true });
  f.change = () => { f.reviews.reverse(); f.threads.reverse(); };
  assert.equal((await run(f)).status, 'validated');
});
