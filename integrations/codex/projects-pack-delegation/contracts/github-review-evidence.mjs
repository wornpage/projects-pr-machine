import { ReadinessError, captureData, dataDigest, exactKeys, isOid, isRepository,
  requireThat } from './readiness-data.mjs';

export const REVIEW_THREADS_QUERY = `query ReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    headRefOid baseRefOid reviewThreads(first:100,after:$after){
      nodes{id isResolved} pageInfo{hasNextPage endCursor}
    }
  }}
}`;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
function identity(pr, expected) {
  requireThat(pr?.number === expected.number && pr.state === 'open' && pr.merged === false
    && pr.head?.sha === expected.headOid && pr.base?.sha === expected.baseOid
    && pr.head?.repo?.full_name?.toLowerCase() === expected.repository.toLowerCase()
    && pr.base?.repo?.full_name?.toLowerCase() === expected.repository.toLowerCase()
    && positiveInteger(pr.user?.id), 'review_revision_mismatch');
  return pr.user.id;
}

/** Obtain independent REVIEW APPROVAL evidence, not a review-generation model.
 * Trusted policy must be supplied outside PR/worker data. client must read the
 * authenticated GitHub APIs. Caller JSON is not a substitute for those reads.
 * Current/base observations bracket the paginated reads but do not lock GitHub.
 */
export async function readGitHubReviewEvidence(expectedInput, clientInput) {
  try {
    const expected = captureData(expectedInput);
    exactKeys(expected, ['repository', 'number', 'baseOid', 'headOid', 'reviewerIds', 'excludedIds', 'minimumApprovals']);
    requireThat(isRepository(expected.repository) && positiveInteger(expected.number)
      && isOid(expected.baseOid) && isOid(expected.headOid)
      && Array.isArray(expected.reviewerIds) && expected.reviewerIds.length > 0
      && expected.reviewerIds.every(positiveInteger)
      && new Set(expected.reviewerIds).size === expected.reviewerIds.length
      && Array.isArray(expected.excludedIds) && expected.excludedIds.length > 0
      && expected.excludedIds.every(positiveInteger)
      && positiveInteger(expected.minimumApprovals) && expected.minimumApprovals <= expected.reviewerIds.length,
    'invalid_review_policy');
    requireThat(typeof clientInput?.rest === 'function' && typeof clientInput.graphql === 'function', 'missing_adapter');
    const rest = clientInput.rest.bind(clientInput); const graphql = clientInput.graphql.bind(clientInput);
    const resource = `repos/${expected.repository}/pulls/${expected.number}`;
    const authorId = identity(await rest(resource), expected);
    const excluded = new Set([...expected.excludedIds, authorId]);
    const latest = new Map(); const reviewIds = new Set(); const observed = [];
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const reviews = await rest(`${resource}/reviews?per_page=100&page=${page}`);
      requireThat(Array.isArray(reviews) && reviews.length <= 100, 'incomplete_review_observation');
      for (const review of reviews) {
        requireThat(positiveInteger(review?.id) && positiveInteger(review.user?.id)
          && !reviewIds.has(review.id)
          && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED', 'PENDING'].includes(review.state),
        'invalid_review_observation');
        reviewIds.add(review.id);
        if (review.state === 'PENDING') continue;
        requireThat(isOid(review.commit_id) && typeof review.submitted_at === 'string'
          && Number.isFinite(Date.parse(review.submitted_at)), 'invalid_review_observation');
        const normalized = { id: review.id, actorId: review.user.id, state: review.state, headOid: review.commit_id, submittedAt: review.submitted_at };
        observed.push(normalized);
        // A comment does not withdraw an earlier approval or request for changes.
        if (review.state === 'COMMENTED') continue;
        const previous = latest.get(review.user.id);
        if (!previous || Date.parse(review.submitted_at) > Date.parse(previous.submittedAt)
          || (Date.parse(review.submitted_at) === Date.parse(previous.submittedAt) && review.id > previous.id)) {
          latest.set(review.user.id, normalized);
        }
      }
      if (reviews.length < 100) { complete = true; break; }
    }
    requireThat(complete, 'incomplete_review_observation');
    requireThat(![...latest.values()].some(review => review.state === 'CHANGES_REQUESTED'), 'changes_requested');
    const approvals = [...latest.values()].filter(review => review.state === 'APPROVED'
      && review.headOid === expected.headOid && expected.reviewerIds.includes(review.actorId)
      && !excluded.has(review.actorId)).sort((a, b) => a.id - b.id);
    requireThat(approvals.length >= expected.minimumApprovals, 'independent_review_required');

    const [owner, name] = expected.repository.split('/');
    const threads = []; const threadIds = new Set(); const cursors = new Set(); let after = null;
    complete = false;
    for (let page = 0; page < 10; page++) {
      const response = await graphql(REVIEW_THREADS_QUERY, { owner, name, number: expected.number, after });
      requireThat(!response?.errors || (Array.isArray(response.errors) && response.errors.length === 0), 'github_observation_failed');
      const pr = response?.data?.repository?.pullRequest;
      requireThat(pr?.headRefOid === expected.headOid && pr.baseRefOid === expected.baseOid, 'review_revision_mismatch');
      const connection = pr.reviewThreads;
      requireThat(Array.isArray(connection?.nodes) && connection.nodes.length <= 100
        && typeof connection.pageInfo?.hasNextPage === 'boolean', 'incomplete_review_observation');
      for (const thread of connection.nodes) {
        requireThat(typeof thread?.id === 'string' && thread.id.length > 0 && thread.id.length <= 200
          && !threadIds.has(thread.id) && typeof thread.isResolved === 'boolean', 'invalid_review_observation');
        requireThat(thread.isResolved === true, 'unresolved_review_thread');
        threadIds.add(thread.id); threads.push(thread.id);
      }
      if (!connection.pageInfo.hasNextPage) { complete = true; break; }
      after = connection.pageInfo.endCursor;
      requireThat(typeof after === 'string' && after.length > 0 && after.length <= 1000
        && !cursors.has(after), 'incomplete_review_observation');
      cursors.add(after);
    }
    requireThat(complete, 'incomplete_review_observation');
    requireThat(identity(await rest(resource), expected) === authorId, 'review_revision_mismatch');
    return captureData({ schemaVersion: 1, kind: 'github-review-evidence', status: 'validated',
      repository: expected.repository, number: expected.number, baseOid: expected.baseOid, headOid: expected.headOid,
      reviewerIds: approvals.map(review => review.actorId), reviewIds: approvals.map(review => review.id),
      evidenceSha256: dataDigest({ expected, authorId, reviews: observed.sort((a, b) => a.id - b.id), threads: threads.sort() }) });
  } catch (error) {
    if (error instanceof ReadinessError) throw error;
    throw new ReadinessError('github_observation_failed');
  }
}
