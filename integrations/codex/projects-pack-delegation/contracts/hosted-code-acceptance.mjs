import { createCodeHandoffAcceptanceSchema } from './code-handoff-acceptance.mjs';
import { ReadinessError, captureData, dataDigest, exactKeys, isDigest, isId,
  isOid, isRepository, requireThat, sha256 } from './readiness-data.mjs';

function assignmentContract(a, principal, request) {
  requireThat(a && a.id === request.assignmentId && a.tenantId === principal.tenantId
    && a.kind === 'code' && a.status === 'submitted'
    && Number.isSafeInteger(a.version) && a.version >= 0 && a.version < Number.MAX_SAFE_INTEGER
    && a.version === request.expectedVersion, 'stale_assignment');
  requireThat(isRepository(a.repository) && isOid(a.baseOid) && isOid(a.headOid)
    && isDigest(a.contextSha256) && isId(a.workerActorId)
    && Array.isArray(a.workerGitHubIds) && a.workerGitHubIds.length > 0
    && a.workerGitHubIds.every(id => Number.isSafeInteger(id) && id > 0), 'invalid_assignment');
  requireThat(a.workerActorId !== principal.actorId, 'worker_self_acceptance');
}
const tupleMatches = (evidence, assignment) => evidence?.repository === assignment.repository
  && evidence.baseOid === assignment.baseOid && evidence.headOid === assignment.headOid;

/** Host integration boundary, NOT an HTTP server or an enabled deployment.
 *
 * principal must come from authenticated server middleware, never request JSON.
 * store.transaction(scope, callback) must provide serializable assignment access;
 * authorize must recheck current session/tenant/role/revocation inside that scope.
 * commitAcceptance must atomically CAS assignment version AND persist the audit
 * event and unique (tenant, assignment, actor, key) idempotency record. Its true
 * return means durably committed. Callback retries may repeat only read adapters.
 *
 * validateHandoff must be a real Draft 2020-12 validator, with coercion/defaults/
 * removal/remote refs disabled. Evidence readers must use trusted stores or
 * authenticated providers, never fields supplied in the worker's handoff.
 */
export function createHostedCodeAcceptance(adapters, policy) {
  const deps = Object.freeze({ ...adapters });
  for (const name of ['validateHandoff', 'readReview', 'readVerification', 'observeRevision']) {
    requireThat(typeof deps[name] === 'function', 'missing_adapter');
  }
  requireThat(typeof deps.store?.transaction === 'function', 'missing_adapter');
  const transaction = deps.store.transaction.bind(deps.store);
  const trusted = captureData(policy);
  exactKeys(trusted, ['reviewerIds', 'runnerIds']);
  requireThat(Array.isArray(trusted.reviewerIds) && trusted.reviewerIds.length > 0
    && trusted.reviewerIds.every(id => Number.isSafeInteger(id) && id > 0)
    && new Set(trusted.reviewerIds).size === trusted.reviewerIds.length
    && Array.isArray(trusted.runnerIds) && trusted.runnerIds.length > 0
    && trusted.runnerIds.every(isId) && new Set(trusted.runnerIds).size === trusted.runnerIds.length,
  'invalid_policy');

  return async function acceptCode(principalInput, requestInput) {
    let committing = false;
    try {
      const principal = captureData(principalInput);
      const request = captureData(requestInput);
      exactKeys(principal, ['tenantId', 'actorId', 'sessionId']);
      exactKeys(request, ['assignmentId', 'expectedVersion', 'idempotencyKey', 'handoff']);
      requireThat(Object.values(principal).every(isId) && isId(request.assignmentId)
        && isId(request.idempotencyKey) && Number.isSafeInteger(request.expectedVersion)
        && request.expectedVersion >= 0, 'invalid_request');
      const requestSha256 = dataDigest({ tenantId: principal.tenantId, actorId: principal.actorId, request });
      const scope = { tenantId: principal.tenantId, assignmentId: request.assignmentId };
      const result = await transaction(scope, async tx => {
        for (const name of ['authorize', 'getAssignment', 'getIdempotency', 'commitAcceptance']) {
          requireThat(typeof tx?.[name] === 'function', 'missing_adapter');
        }
        const authorization = () => tx.authorize(principal, 'accept-code');
        requireThat(await authorization() === true, 'acceptance_forbidden');
        const replay = await tx.getIdempotency(principal.actorId, request.idempotencyKey);
        if (replay !== null) {
          requireThat(replay?.requestSha256 === requestSha256, 'idempotency_conflict');
          requireThat(replay.receipt?.kind === 'hosted-code-acceptance'
            && replay.receipt.status === 'accepted' && replay.receipt.assignmentId === request.assignmentId
            && replay.receipt.tenantId === principal.tenantId
            && replay.receipt.actorId === principal.actorId
            && replay.receiptSha256 === dataDigest(replay.receipt), 'invalid_saved_receipt');
          requireThat(await authorization() === true, 'acceptance_forbidden');
          return captureData(replay.receipt);
        }
        const assignment = captureData(await tx.getAssignment());
        assignmentContract(assignment, principal, request);
        const schema = createCodeHandoffAcceptanceSchema({ packId: assignment.packId,
          workerId: assignment.workerId, verificationCommand: assignment.verificationCommand });
        // A truthy validator object or undefined is never an acceptance decision.
        requireThat(await deps.validateHandoff(schema, request.handoff) === true, 'invalid_handoff');
        const assignmentSha256 = dataDigest(assignment);
        const review = captureData(await deps.readReview(assignment));
        requireThat(tupleMatches(review, assignment) && review.contextSha256 === assignment.contextSha256
          && review.status === 'validated' && review.reportValidated === true && isDigest(review.reportSha256)
          && Array.isArray(review.reviewerIds) && review.reviewerIds.length > 0
          && review.reviewerIds.every(id => trusted.reviewerIds.includes(id)
            && !assignment.workerGitHubIds.includes(id)), 'independent_review_required');
        const execution = captureData(await deps.readVerification(assignment));
        requireThat(tupleMatches(execution, assignment) && execution.passed === true
          && trusted.runnerIds.includes(execution.runnerId) && isDigest(execution.artifactSha256)
          && execution.commandSha256 === sha256(assignment.verificationCommand), 'verification_required');
        const current = captureData(await deps.observeRevision(assignment));
        requireThat(tupleMatches(current, assignment) && current.contextSha256 === assignment.contextSha256,
          'stale_revision');
        // Recheck authorization after external observations, including revocation.
        requireThat(await authorization() === true, 'acceptance_forbidden');
        const receipt = captureData({ schemaVersion: 1, kind: 'hosted-code-acceptance', status: 'accepted',
          tenantId: principal.tenantId, actorId: principal.actorId, assignmentId: assignment.id,
          version: assignment.version + 1, repository: assignment.repository,
          baseOid: assignment.baseOid, headOid: assignment.headOid, contextSha256: assignment.contextSha256,
          assignmentSha256, handoffSha256: dataDigest(request.handoff),
          reviewSha256: dataDigest(review), verificationSha256: dataDigest(execution) });
        committing = true;
        const committed = await tx.commitAcceptance({ expectedVersion: assignment.version, receipt,
          event: { kind: 'code-accepted', ...scope, actorId: principal.actorId, receiptSha256: dataDigest(receipt) },
          idempotency: { actorId: principal.actorId, key: request.idempotencyKey, requestSha256, receiptSha256: dataDigest(receipt), receipt } });
        if (committed !== true) {
          committing = false;
          throw new ReadinessError('acceptance_conflict');
        }
        return receipt;
      });
      committing = false;
      return result;
    } catch (error) {
      // A lost commit response is not evidence that persistence failed. Retry only
      // the SAME request/key after observation; adapters must preserve the record.
      if (committing) throw new ReadinessError('acceptance_outcome_unknown');
      if (error instanceof ReadinessError) throw error;
      throw new ReadinessError('acceptance_unavailable');
    }
  };
}
