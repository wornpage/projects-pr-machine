import { ReadinessError, captureData, dataDigest, exactKeys, isDigest, isId,
  isOid, isRepository, requireThat } from './readiness-data.mjs';

const natural = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => natural(n) && n > 0;
const same = (a, b) => dataDigest(a) === dataDigest(b);
const check = condition => requireThat(condition, 'invalid_progress_event');
const roles = ['worker', 'reviewer', 'coordinator', 'owner', 'operator'];
const decisions = ['submit-evidence', 'review-revision', 'accept-or-rework', 'revise-and-resubmit',
  'create-draft', 'authorize-merge', 'merge-reviewed-revision', 'deploy-artifact',
  'verify-deployment', 'recover-lifecycle', 'supply-integration', 'resolve-checks', 'confirm-goal'];
const reasons = ['evidence-invalid', 'required-checks', 'unavailable-provider',
  'external-integration', 'release-approval', 'recovery-needed', 'scope-changed'];
const next = {
  running: ['worker', 'submit-evidence'], 'rework-requested': ['worker', 'revise-and-resubmit'],
  'evidence-accepted': ['owner', 'create-draft'], 'draft-created': ['owner', 'authorize-merge'],
  'merge-authorized': ['owner', 'merge-reviewed-revision'], merged: ['operator', 'deploy-artifact'],
  deployed: ['operator', 'verify-deployment']
};
function revision(value) {
  exactKeys(value, ['repository', 'baseOid', 'headOid']);
  check(isRepository(value.repository) && isOid(value.baseOid) && isOid(value.headOid));
  return value;
}
function fields(data, names) { exactKeys(data, names); }
function evidence(data) { check(isDigest(data.evidenceSha256)); }
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b); const n = sorted.length;
  return { samples: n, medianMs: n ? (n % 2 ? sorted[(n - 1) / 2]
    : sorted[n / 2 - 1] + (sorted[n / 2] - sorted[n / 2 - 1]) / 2) : null,
  p90Ms: n ? sorted[Math.ceil(n * 0.9) - 1] : null };
}
function ratio(numerator, denominator, missing = 0) {
  return { numerator, denominator, missing, value: denominator > 0 && missing === 0 ? numerator / denominator : null };
}
function action(ownerRole, decision, fields = {}) { return { ownerRole, decision, ...fields }; }
function deploymentState(s) {
  // A later staging observation cannot overwrite a still-active production fact.
  s.deployment = s.activeDeployments.get('production') ?? s.activeDeployments.get('staging') ?? null;
  s.stage = s.deployment ? (s.deployment.verified ? 'post-deployment-verified' : 'deployed') : 'merged';
}
function deploymentView(dep) {
  return { deploymentId: dep.deploymentId, sourceOid: dep.sourceOid,
    artifactSha256: dep.artifactSha256, environment: dep.environment, verified: dep.verified,
    deployedAtMs: dep.atMs, lastVerifiedAtMs: dep.lastVerifiedAtMs };
}

/** Pure reporting ONLY. The host authenticates/authorizes the read and supplies a
 * complete tenant/goal-scoped durable log, a consistent watermark and trusted
 * reporting policy. Never accept a worker's claimed event log as provider truth.
 * No fetch, effects, inferred approvals, implicit parent completion or clock reads.
 */
export function projectWorkProgress(scopeInput, logInput) {
  try {
    const scope = captureData(scopeInput); const log = captureData(logInput);
    fields(scope, ['tenantId', 'goalId', 'asOfMs', 'costUnit', 'defectWindowMs']);
    check(isId(scope.tenantId) && isId(scope.goalId) && natural(scope.asOfMs)
      && isId(scope.costUnit) && positive(scope.defectWindowMs));
    fields(log, ['schemaVersion', 'complete', 'lastSequence', 'events']);
    requireThat(log.schemaVersion === 1 && log.complete === true && natural(log.lastSequence)
      && Array.isArray(log.events) && log.events.length <= 256, 'incomplete_progress_log');
    const seen = new Map(); const assignments = new Map(); const deployments = new Map();
    const waits = []; let abandonedReviews = 0; let sequence = 0; let atMs = 0; let goalOutcome = null;
    for (const event of log.events) {
      fields(event, ['id', 'sequence', 'tenantId', 'goalId', 'assignmentId', 'actorId', 'atMs', 'type', 'data']);
      requireThat(event.tenantId === scope.tenantId && event.goalId === scope.goalId, 'progress_scope_mismatch');
      check(isId(event.id) && isId(event.actorId) && positive(event.sequence)
        && natural(event.atMs) && event.atMs <= scope.asOfMs && typeof event.type === 'string');
      const digest = dataDigest(event);
      if (seen.has(event.id)) { requireThat(seen.get(event.id) === digest, 'progress_event_conflict'); continue; }
      requireThat(event.sequence === sequence + 1 && event.atMs >= atMs, 'incomplete_progress_log');
      seen.set(event.id, digest); sequence = event.sequence; atMs = event.atMs;
      const d = event.data;
      if (event.assignmentId === null) {
        if (event.type === 'goal-confirmed') {
          fields(d, ['outcome', 'evidenceSha256']); evidence(d);
          check(['code-delivery', 'production'].includes(d.outcome) && assignments.size > 0);
          check([...assignments.values()].every(s => s.mergeOid && !s.blockers.size && !s.interruptions.size
            && (d.outcome === 'code-delivery' || (s.deployment?.verified && s.deployment.environment === 'production'))));
          goalOutcome = { ...d, eventId: event.id, actorId: event.actorId, atMs };
        } else {
          check(event.type === 'goal-reopened'); fields(d, ['reasonCode']); check(reasons.includes(d.reasonCode));
          goalOutcome = null;
        }
        continue;
      }
      check(isId(event.assignmentId));
      if (event.type === 'work-started') {
        fields(d, ['revision']); revision(d.revision);
        check(!assignments.has(event.assignmentId) && assignments.size < 64);
        assignments.set(event.assignmentId, { id: event.assignmentId, stage: 'running', revision: d.revision,
          startedAtMs: atMs, firstAcceptedAtMs: null, firstPass: null, submissions: 0, submission: null,
          review: null, lastReviewedRevision: null, acceptance: null, prNumber: null, authorizationId: null,
          mergeOid: null, deployment: null, activeDeployments: new Map(), cost: null, blockers: new Map(), interruptions: new Map(),
          interruptionIds: new Set(), recovered: 0, overrides: new Set(), submissionIds: new Set(),
          blockerIds: new Set(), updatedAtMs: atMs, lastEventId: event.id, lastEventType: event.type });
        goalOutcome = null; continue;
      }
      const s = assignments.get(event.assignmentId); check(s);
      const inStage = (...allowed) => check(allowed.includes(s.stage));
      const boundRevision = () => check(same(revision(d.revision), s.revision));
      const finishWait = () => {
        if (s.submission && !s.review) waits.push(atMs - s.submission.atMs);
      };
      const boundDeployment = () => {
        const dep = deployments.get(d.deploymentId);
        check(dep && dep.assignmentId === s.id && dep === s.activeDeployments.get(d.environment) && dep.sourceOid === d.sourceOid
          && dep.artifactSha256 === d.artifactSha256 && dep.environment === d.environment);
        return dep;
      };
      switch (event.type) {
        case 'revision-changed':
          fields(d, ['revision']); revision(d.revision);
          check(!s.mergeOid && d.revision.repository === s.revision.repository && !same(d.revision, s.revision));
          if (s.submission && !s.review) abandonedReviews++;
          Object.assign(s, { stage: 'running', revision: d.revision, submission: null, review: null,
            acceptance: null, prNumber: null, authorizationId: null, cost: null });
          goalOutcome = null; break;
        case 'evidence-submitted':
          fields(d, ['revision', 'submissionId', 'evidenceSha256']); boundRevision(); evidence(d);
          inStage('running', 'rework-requested'); check(isId(d.submissionId) && !s.submissionIds.has(d.submissionId));
          s.submissionIds.add(d.submissionId); s.submissions++; s.review = null;
          s.submission = { ...d, atMs }; s.stage = 'evidence-submitted'; break;
        case 'review-recorded':
          fields(d, ['revision', 'submissionId', 'reviewId', 'evidenceSha256']); boundRevision(); evidence(d);
          inStage('evidence-submitted'); check(!s.review && d.submissionId === s.submission.submissionId && isId(d.reviewId));
          finishWait(); s.review = { ...d, atMs }; s.lastReviewedRevision = d.revision; break;
        case 'rework-requested':
          fields(d, ['revision', 'submissionId', 'reasonCode']); boundRevision();
          inStage('evidence-submitted'); check(d.submissionId === s.submission.submissionId && reasons.includes(d.reasonCode));
          finishWait(); s.submission = null; s.stage = 'rework-requested'; break;
        case 'evidence-accepted':
          fields(d, ['revision', 'submissionId', 'reviewId', 'acceptanceId', 'evidenceSha256']); boundRevision(); evidence(d);
          inStage('evidence-submitted'); check(s.review && d.reviewId === s.review.reviewId
            && d.submissionId === s.submission.submissionId && isId(d.acceptanceId));
          s.acceptance = { ...d, atMs }; s.stage = 'evidence-accepted';
          if (s.firstAcceptedAtMs === null) { s.firstAcceptedAtMs = atMs; s.firstPass = s.submissions === 1; }
          break;
        case 'draft-created':
          fields(d, ['revision', 'prNumber']); boundRevision(); inStage('evidence-accepted'); check(positive(d.prNumber));
          s.prNumber = d.prNumber; s.stage = 'draft-created'; break;
        case 'merge-authorized':
          fields(d, ['revision', 'prNumber', 'authorizationId']); boundRevision(); inStage('draft-created');
          check(d.prNumber === s.prNumber && isId(d.authorizationId));
          s.authorizationId = d.authorizationId; s.stage = 'merge-authorized'; break;
        case 'merged':
          fields(d, ['revision', 'prNumber', 'authorizationId', 'mergeOid']); boundRevision(); inStage('merge-authorized');
          check(d.prNumber === s.prNumber && d.authorizationId === s.authorizationId && isOid(d.mergeOid));
          s.mergeOid = d.mergeOid; s.stage = 'merged'; break;
        case 'deployed':
          fields(d, ['deploymentId', 'sourceOid', 'artifactSha256', 'environment']);
          inStage('merged', 'deployed', 'post-deployment-verified');
          check(isId(d.deploymentId) && !deployments.has(d.deploymentId) && d.sourceOid === s.mergeOid
            && isDigest(d.artifactSha256) && ['staging', 'production'].includes(d.environment));
          s.deployment = { ...d, assignmentId: s.id, atMs, verified: false,
            firstVerifiedAtMs: null, lastVerifiedAtMs: null, windowThroughMs: null, defects: new Map() };
          deployments.set(d.deploymentId, s.deployment); s.activeDeployments.set(d.environment, s.deployment);
          deploymentState(s); goalOutcome = null; break;
        case 'post-deployment-verified':
        case 'deployment-health-failed':
        case 'deployment-ended': {
          fields(d, ['deploymentId', 'sourceOid', 'artifactSha256', 'environment', 'evidenceSha256']); evidence(d);
          inStage('deployed', 'post-deployment-verified'); const dep = boundDeployment();
          if (event.type === 'post-deployment-verified') {
            check(!dep.verified); dep.verified = true; dep.firstVerifiedAtMs ??= atMs; dep.lastVerifiedAtMs = atMs;
            deploymentState(s);
          } else {
            dep.verified = false; goalOutcome = null;
            if (event.type === 'deployment-ended') s.activeDeployments.delete(d.environment);
            deploymentState(s);
          }
          break;
        }
        case 'blocker-raised':
          fields(d, ['blockerId', 'code', 'ownerRole', 'decision']);
          check(isId(d.blockerId) && !s.blockerIds.has(d.blockerId) && reasons.includes(d.code)
            && roles.includes(d.ownerRole) && decisions.includes(d.decision));
          s.blockerIds.add(d.blockerId); s.blockers.set(d.blockerId, d); goalOutcome = null; break;
        case 'blocker-cleared':
          fields(d, ['blockerId']); check(s.blockers.delete(d.blockerId)); break;
        case 'lifecycle-interrupted':
          fields(d, ['interruptionId', 'evidenceSha256']); evidence(d);
          check(isId(d.interruptionId) && !s.interruptionIds.has(d.interruptionId));
          s.interruptionIds.add(d.interruptionId); s.interruptions.set(d.interruptionId, atMs); goalOutcome = null; break;
        case 'lifecycle-recovered':
          fields(d, ['interruptionId', 'evidenceSha256']); evidence(d); check(s.interruptions.delete(d.interruptionId));
          s.recovered++; break;
        case 'manual-override-recorded':
          fields(d, ['overrideId', 'reasonCode', 'evidenceSha256']); evidence(d);
          check(isId(d.overrideId) && !s.overrides.has(d.overrideId) && reasons.includes(d.reasonCode));
          s.overrides.add(d.overrideId); break;
        case 'execution-cost-finalized':
          fields(d, ['acceptanceId', 'units', 'unit', 'evidenceSha256']); evidence(d);
          check(s.acceptance && d.acceptanceId === s.acceptance.acceptanceId && !s.cost
            && natural(d.units) && d.unit === scope.costUnit); s.cost = d; break;
        case 'defect-recorded': {
          fields(d, ['deploymentId', 'defectId', 'detectedAtMs', 'evidenceSha256']); evidence(d);
          const dep = deployments.get(d.deploymentId);
          check(dep && dep.assignmentId === s.id && dep.firstVerifiedAtMs !== null && isId(d.defectId)
            && !dep.defects.has(d.defectId) && natural(d.detectedAtMs)
            && d.detectedAtMs >= dep.firstVerifiedAtMs && d.detectedAtMs <= atMs);
          dep.defects.set(d.defectId, d.detectedAtMs); break;
        }
        case 'defect-window-closed': {
          fields(d, ['deploymentId', 'throughMs', 'evidenceSha256']); evidence(d);
          const dep = deployments.get(d.deploymentId);
          check(dep && dep.assignmentId === s.id && dep.firstVerifiedAtMs !== null && dep.windowThroughMs === null
            && natural(d.throughMs) && d.throughMs === dep.firstVerifiedAtMs + scope.defectWindowMs && d.throughMs <= atMs);
          dep.windowThroughMs = d.throughMs; break;
        }
        default: throw new ReadinessError('unknown_progress_event');
      }
      s.updatedAtMs = atMs; s.lastEventId = event.id; s.lastEventType = event.type;
    }
    requireThat(sequence === log.lastSequence, 'incomplete_progress_log');
    const work = [...assignments.values()];
    const everAccepted = work.filter(s => s.firstAcceptedAtMs !== null);
    const accepted = work.filter(s => s.acceptance !== null);
    const verifiedDeployments = [...deployments.values()].filter(d => d.firstVerifiedAtMs !== null && d.environment === 'production');
    const closed = verifiedDeployments.filter(d => d.windowThroughMs !== null);
    const escaped = closed.filter(d => [...d.defects.values()].some(t => t < d.windowThroughMs));
    const cost = work.reduce((n, s) => n + (s.cost?.units ?? 0), 0); check(natural(cost));
    const projection = work.map(s => {
      const pending = s.stage === 'evidence-submitted'
        ? (s.review ? ['coordinator', 'accept-or-rework'] : ['reviewer', 'review-revision']) : next[s.stage];
      const blockers = [...s.blockers.values()];
      const actions = blockers.map(b => action(b.ownerRole, b.decision, { blockerId: b.blockerId, code: b.code }));
      for (const id of s.interruptions.keys()) actions.push(action('operator', 'recover-lifecycle', { interruptionId: id }));
      if (!actions.length && pending) actions.push(action(...pending));
      const dep = s.deployment;
      return { assignmentId: s.id, stage: s.stage, revision: s.revision, lastReviewedRevision: s.lastReviewedRevision,
        reviewId: s.review?.reviewId ?? null, reviewedAtMs: s.review?.atMs ?? null,
        acceptedAtMs: s.acceptance?.atMs ?? null, acceptanceId: s.acceptance?.acceptanceId ?? null,
        prNumber: s.prNumber, authorizationId: s.authorizationId, mergeOid: s.mergeOid,
        deployment: dep ? deploymentView(dep) : null,
        activeDeployments: [...s.activeDeployments.values()].map(deploymentView),
        productionVerified: dep?.environment === 'production' && dep.verified,
        blockers, pendingActions: actions, updatedAtMs: s.updatedAtMs, lastEventId: s.lastEventId, lastEventType: s.lastEventType };
    });
    return captureData({ schemaVersion: 1, kind: 'work-progress', tenantId: scope.tenantId, goalId: scope.goalId,
      asOfMs: scope.asOfMs, lastSequence: sequence, logSha256: dataDigest([...seen]),
      goalOutcome, goalComplete: goalOutcome !== null,
      pendingGoalActions: !goalOutcome && work.length > 0 && work.every(s => s.mergeOid
        && !s.blockers.size && !s.interruptions.size) ? [action('coordinator', 'confirm-goal')] : [],
      productionVerified: work.length > 0 && projection.every(s => s.productionVerified),
      assignments: projection,
      metrics: {
        acceptedOutcomeLeadTime: { ...stats(everAccepted.map(s => s.firstAcceptedAtMs - s.startedAtMs)),
          pending: work.length - everAccepted.length },
        firstPassAcceptance: ratio(everAccepted.filter(s => s.firstPass).length, everAccepted.length),
        reviewWaitingTime: { ...stats(waits), pending: work.filter(s => s.submission && !s.review).length,
          abandoned: abandonedReviews },
        acceptedOutcomesPerCostUnit: { ...ratio(accepted.length, cost, work.filter(s => !s.cost).length), unit: scope.costUnit },
        escapedDefectRate: { ...ratio(escaped.length, closed.length, verifiedDeployments.length - closed.length),
          windowMs: scope.defectWindowMs, environment: 'production' },
        successfulRecoveries: ratio(work.reduce((n, s) => n + s.recovered, 0),
          work.reduce((n, s) => n + s.interruptionIds.size, 0)),
        manualOverrides: work.reduce((n, s) => n + s.overrides.size, 0)
      } });
  } catch (error) {
    if (error instanceof ReadinessError) throw error;
    throw new ReadinessError('progress_unavailable');
  }
}
