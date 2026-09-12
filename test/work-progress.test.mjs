import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkProgress }
  from '../integrations/codex/projects-pack-delegation/contracts/work-progress.mjs';

const hash = 'd'.repeat(64);
const rev = { repository: 'fixture/project', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) };
const mergeOid = 'c'.repeat(40);
const proof = { evidenceSha256: hash };
const scope = { tenantId: 'tenant', goalId: 'goal', asOfMs: 1_000_000, costUnit: 'runner-unit', defectWindowMs: 1_000 };
function fixture() {
  const b = { events: [], now: 0, id: 'work1', revision: { ...rev }, dep: null };
  b.emit = (type, data, assignmentId = b.id) => {
    b.now += 100;
    b.events.push({ id: `event${b.events.length + 1}`, sequence: b.events.length + 1, tenantId: 'tenant', goalId: 'goal',
      assignmentId, actorId: 'service-actor', atMs: b.now, type, data: structuredClone(data) });
    return b;
  };
  b.start = () => b.emit('work-started', { revision: b.revision });
  b.submit = (id = 'submission1') => b.emit('evidence-submitted', { revision: b.revision, submissionId: id, ...proof });
  b.review = (submissionId = 'submission1') => b.emit('review-recorded', { revision: b.revision, submissionId, reviewId: 'review1', ...proof });
  b.accept = (submissionId = 'submission1') => b.emit('evidence-accepted', { revision: b.revision, submissionId,
    reviewId: 'review1', acceptanceId: 'acceptance1', ...proof });
  b.accepted = () => b.start().submit().review().accept();
  b.draft = () => b.emit('draft-created', { revision: b.revision, prNumber: 1 });
  b.authorize = () => b.emit('merge-authorized', { revision: b.revision, prNumber: 1, authorizationId: 'auth1' });
  b.merge = () => b.emit('merged', { revision: b.revision, prNumber: 1, authorizationId: 'auth1', mergeOid });
  b.merged = () => b.accepted().draft().authorize().merge();
  b.deploy = (environment = 'production', deploymentId = 'dep1') => {
    b.dep = { deploymentId, sourceOid: mergeOid, artifactSha256: hash, environment };
    return b.emit('deployed', b.dep);
  };
  b.verify = () => b.emit('post-deployment-verified', { ...b.dep, ...proof });
  b.verified = () => b.merged().deploy().verify();
  b.log = () => ({ schemaVersion: 1, complete: true, lastSequence: b.events.length, events: b.events });
  b.run = () => projectWorkProgress(scope, b.log());
  return b;
}
const current = b => b.run().assignments[0];
const refused = (b, code) => assert.throws(b.run, code ? { code } : undefined);

test('progress: empty complete log reports unknown metrics and no completion', () => {
  const r = fixture().run(); assert.equal(r.goalComplete, false); assert.equal(r.productionVerified, false);
  assert.equal(r.metrics.acceptedOutcomeLeadTime.medianMs, null);
  for (const key of ['firstPassAcceptance', 'acceptedOutcomesPerCostUnit', 'escapedDefectRate', 'successfulRecoveries']) {
    assert.equal(r.metrics[key].value, null);
  }
});
test('progress: every delivery stage is explicit; no child event completes the parent', () => {
  const b = fixture();
  for (const [method, stage] of [['start', 'running'], ['submit', 'evidence-submitted'],
    ['review', 'evidence-submitted'], ['accept', 'evidence-accepted'], ['draft', 'draft-created'],
    ['authorize', 'merge-authorized'], ['merge', 'merged'], ['deploy', 'deployed'], ['verify', 'post-deployment-verified']]) {
    b[method](); const r = b.run(); assert.equal(r.assignments[0].stage, stage);
    assert.equal(r.goalComplete, false); assert.equal(r.productionVerified, method === 'verify');
  }
  b.emit('goal-confirmed', { outcome: 'production', ...proof }, null);
  assert.equal(b.run().goalComplete, true); assert.equal(b.run().goalOutcome.outcome, 'production');
});
test('progress: code delivery confirmation is not a deployment confirmation', () => {
  const b = fixture().merged().emit('goal-confirmed', { outcome: 'code-delivery', ...proof }, null);
  assert.equal(b.run().goalComplete, true); assert.equal(b.run().productionVerified, false);
  assert.equal(current(b).deployment, null); assert.equal(current(b).pendingActions[0].decision, 'deploy-artifact');
});
test('progress: verified staging cannot satisfy a production goal', () => {
  const b = fixture().merged().deploy('staging').verify(); assert.equal(b.run().productionVerified, false);
  b.emit('goal-confirmed', { outcome: 'production', ...proof }, null); refused(b);
});
test('progress: one merged child cannot complete a goal with another unfinished child', () => {
  const b = fixture().merged(); b.id = 'work2'; b.start();
  b.emit('goal-confirmed', { outcome: 'code-delivery', ...proof }, null); refused(b);
});
test('progress: new scope invalidates an explicit parent confirmation', () => {
  const b = fixture().merged().emit('goal-confirmed', { outcome: 'code-delivery', ...proof }, null);
  b.id = 'work2'; b.start(); assert.equal(b.run().goalComplete, false);
});
test('progress: owner decisions distinguish pending review from pending acceptance', () => {
  const b = fixture().start().submit();
  assert.deepEqual(current(b).pendingActions, [{ ownerRole: 'reviewer', decision: 'review-revision' }]);
  b.review(); assert.deepEqual(current(b).pendingActions, [{ ownerRole: 'coordinator', decision: 'accept-or-rework' }]);
  assert.deepEqual(current(b).lastReviewedRevision, rev); assert.equal(current(b).reviewId, 'review1');
});
for (const field of ['headOid', 'baseOid']) test(`progress: changed ${field} invalidates evidence and delivery decisions`, () => {
  const b = fixture().accepted().draft().authorize().emit('execution-cost-finalized',
    { acceptanceId: 'acceptance1', units: 5, unit: scope.costUnit, ...proof });
  b.revision[field] = 'f'.repeat(40); b.emit('revision-changed', { revision: b.revision });
  const s = current(b); assert.equal(s.stage, 'running');
  for (const key of ['reviewId', 'acceptanceId', 'prNumber', 'authorizationId', 'mergeOid', 'deployment']) assert.equal(s[key], null);
  assert.deepEqual(s.lastReviewedRevision, rev); assert.equal(b.run().metrics.acceptedOutcomesPerCostUnit.value, null);
});
test('progress: rework is distinct and resubmission is not first-pass acceptance', () => {
  const b = fixture().start().submit().emit('rework-requested', { revision: rev, submissionId: 'submission1', reasonCode: 'evidence-invalid' });
  assert.equal(current(b).stage, 'rework-requested');
  b.submit('submission2').review('submission2').accept('submission2');
  assert.equal(b.run().metrics.firstPassAcceptance.value, 0);
  assert.equal(b.run().metrics.reviewWaitingTime.samples, 2);
});
test('progress: byte-equivalent event replay does not double count or alter the digest', () => {
  const b = fixture().verified(); const initial = b.run(); const log = b.log();
  log.events = [...b.events, structuredClone(b.events[3])];
  assert.deepEqual(projectWorkProgress(scope, log), initial);
  log.events[log.events.length - 1].actorId = 'other';
  assert.throws(() => projectWorkProgress(scope, log), { code: 'progress_event_conflict' });
});
for (const [label, mutate, code] of [
  ['wrong tenant', b => { b.events[0].tenantId = 'another'; }, 'progress_scope_mismatch'],
  ['wrong goal', b => { b.events[0].goalId = 'another'; }, 'progress_scope_mismatch'],
  ['sequence gap', b => { b.events[0].sequence = 2; }, 'incomplete_progress_log'],
  ['backwards time', b => { b.events[1].atMs = 0; }, 'incomplete_progress_log'],
  ['future timestamp', b => { b.events[0].atMs = scope.asOfMs + 1; }, 'invalid_progress_event'],
  ['fractional timestamp', b => { b.events[0].atMs = 1.5; }, 'invalid_progress_event'],
  ['missing event ID', b => { b.events[0].id = ''; }, 'invalid_progress_event'],
  ['unknown event', b => { b.events[1].type = 'everything-complete'; }, 'unknown_progress_event'],
  ['extra event field', b => { b.events[0].token = 'PRIVATE'; }, 'invalid_data'],
  ['extra data field', b => { b.events[0].data.approved = true; }, 'invalid_data'],
  ['malformed digest', b => { b.events[1].data.evidenceSha256 = 'good'; }, 'invalid_progress_event'],
  ['changed submission revision', b => { b.events[1].data.revision.headOid = 'e'.repeat(40); }, 'invalid_progress_event'],
  ['reused sequence', b => { b.events[1].sequence = 1; }, 'incomplete_progress_log']
]) test(`progress refuses ${label}`, () => { const b = fixture().start().submit(); mutate(b); refused(b, code); });
for (const [key, value] of [['complete', false], ['complete', 'true'], ['lastSequence', 2], ['schemaVersion', 2]]) {
  test(`progress refuses incomplete or unsupported log ${key}/${value}`, () => {
    const b = fixture().start(); const log = { ...b.log(), [key]: value };
    assert.throws(() => projectWorkProgress(scope, log), { code: 'incomplete_progress_log' });
  });
}
test('progress: never silently truncates a log over its explicit event bound', () => {
  const b = fixture().start(); const log = { ...b.log(), events: Array(257).fill(b.events[0]) };
  assert.throws(() => projectWorkProgress(scope, log), { code: 'incomplete_progress_log' });
});
test('progress: input/output isolation, no getters and no secret-bearing diagnostics', () => {
  const b = fixture().start(); const input = structuredClone(b.log()); const before = structuredClone(input);
  const result = projectWorkProgress(scope, input); assert.deepEqual(input, before);
  input.events[0].data.revision.headOid = 'f'.repeat(40); assert.equal(result.assignments[0].revision.headOid, rev.headOid);
  assert.throws(() => { result.assignments[0].stage = 'merged'; }, TypeError);
  let invoked = false; Object.defineProperty(input.events[0], 'token', { enumerable: true, get() { invoked = true; throw Error('PRIVATE'); } });
  assert.throws(() => projectWorkProgress(scope, input), e => e.code === 'invalid_data' && !String(e).includes('PRIVATE'));
  assert.equal(invoked, false);
});
test('progress: unknown assignment cannot borrow another child state', () => {
  const b = fixture().start().submit(); b.events[1].assignmentId = 'work2'; refused(b);
});
test('progress: acceptance cannot skip independent review evidence', () => { refused(fixture().start().submit().accept()); });
test('progress: acceptance binds exact submission and review identities', () => {
  for (const key of ['submissionId', 'reviewId']) {
    const b = fixture().accepted(); b.events.at(-1).data[key] = 'other'; refused(b);
  }
});
test('progress: merge cannot skip authorization', () => { refused(fixture().accepted().draft().merge()); });
test('progress: merge binds exact PR and authorization identities', () => {
  for (const [key, value] of [['prNumber', 99], ['authorizationId', 'other']]) {
    const b = fixture().merged(); b.events.at(-1).data[key] = value; refused(b);
  }
});
test('progress: deployment binds the actual merge SHA, not the reviewed head', () => {
  const b = fixture().merged().deploy(); b.events.at(-1).data.sourceOid = rev.headOid; refused(b);
});
test('progress: health receipt must bind the exact deployed artifact and environment', () => {
  for (const [key, value] of [['sourceOid', rev.headOid], ['artifactSha256', 'e'.repeat(64)],
    ['deploymentId', 'other'], ['environment', 'staging']]) {
    const b = fixture().verified(); b.events.at(-1).data[key] = value; refused(b);
  }
});
test('progress: replaced deployment never inherits health verification', () => {
  const b = fixture().verified().deploy('production', 'dep2'); assert.equal(current(b).stage, 'deployed');
  assert.equal(b.run().productionVerified, false);
});
for (const type of ['deployment-ended', 'deployment-health-failed']) test(`progress: ${type} clears live verification and parent confirmation`, () => {
  const b = fixture().verified().emit('goal-confirmed', { outcome: 'production', ...proof }, null);
  b.emit(type, { ...b.dep, ...proof }); const r = b.run();
  assert.equal(r.productionVerified, false); assert.equal(r.goalComplete, false);
  assert.equal(current(b).stage, type === 'deployment-ended' ? 'merged' : 'deployed');
});
test('progress: stale deployment teardown cannot erase a replacement', () => {
  const b = fixture().verified(); const old = b.dep; b.deploy('production', 'dep2').emit('deployment-ended', { ...old, ...proof }); refused(b);
});
test('progress: blockers retain an explicit owner decision until individually cleared', () => {
  const b = fixture().start().emit('blocker-raised', { blockerId: 'b1', code: 'external-integration', ownerRole: 'owner', decision: 'supply-integration' });
  b.submit().review().accept(); const s = current(b);
  assert.equal(s.blockers.length, 1); assert.equal(s.pendingActions[0].decision, 'supply-integration');
  b.emit('blocker-cleared', { blockerId: 'b1' }); assert.equal(current(b).blockers.length, 0);
  assert.equal(current(b).pendingActions[0].decision, 'create-draft');
});
test('progress: unresolved blockers forbid parent confirmation despite a merged child', () => {
  const b = fixture().merged().emit('blocker-raised', { blockerId: 'b1', code: 'required-checks', ownerRole: 'owner', decision: 'resolve-checks' });
  b.emit('goal-confirmed', { outcome: 'code-delivery', ...proof }, null); refused(b);
});
test('progress: manual overrides are separate observations, never implicit permission', () => {
  const b = fixture().start().emit('manual-override-recorded', { overrideId: 'o1', reasonCode: 'required-checks', ...proof });
  const r = b.run(); assert.equal(r.metrics.manualOverrides, 1); assert.equal(current(b).stage, 'running');
  assert.equal(r.goalComplete, false); assert.equal(current(b).authorizationId, null);
});
test('progress: interruption/recovery accounting does not advance lifecycle', () => {
  const b = fixture().start().emit('lifecycle-interrupted', { interruptionId: 'i1', ...proof });
  b.emit('lifecycle-interrupted', { interruptionId: 'i2', ...proof });
  assert.equal(current(b).pendingActions.length, 2);
  b.emit('lifecycle-recovered', { interruptionId: 'i1', ...proof });
  assert.equal(b.run().metrics.successfulRecoveries.value, 0.5); assert.equal(current(b).stage, 'running');
  assert.equal(current(b).pendingActions[0].interruptionId, 'i2');
  b.emit('lifecycle-recovered', { interruptionId: 'i1', ...proof }); refused(b);
});
test('progress: pending and abandoned reviews are not fabricated zero-duration samples', () => {
  const b = fixture().start().submit(); assert.equal(b.run().metrics.reviewWaitingTime.samples, 0);
  assert.equal(b.run().metrics.reviewWaitingTime.pending, 1);
  b.revision.headOid = 'f'.repeat(40); b.emit('revision-changed', { revision: b.revision });
  assert.equal(b.run().metrics.reviewWaitingTime.abandoned, 1); assert.equal(b.run().metrics.reviewWaitingTime.pending, 0);
});
test('progress metrics: lead time, first-pass and waiting denominators are reproducible', () => {
  const b = fixture().accepted(); b.id = 'work2'; b.start().submit(); b.now += 100; b.review().accept();
  const m = b.run().metrics;
  assert.deepEqual(m.acceptedOutcomeLeadTime, { samples: 2, medianMs: 350, p90Ms: 400, pending: 0 });
  assert.deepEqual(m.reviewWaitingTime, { samples: 2, medianMs: 150, p90Ms: 200, pending: 0, abandoned: 0 });
  assert.equal(m.firstPassAcceptance.value, 1);
});
test('progress metrics: no cost report is unknown, not free execution', () => {
  const b = fixture().accepted(); assert.equal(b.run().metrics.acceptedOutcomesPerCostUnit.value, null);
  b.emit('execution-cost-finalized', { acceptanceId: 'acceptance1', units: 4, unit: scope.costUnit, ...proof });
  assert.equal(b.run().metrics.acceptedOutcomesPerCostUnit.value, 0.25);
  b.id = 'work2'; b.start(); const metric = b.run().metrics.acceptedOutcomesPerCostUnit;
  assert.equal(metric.value, null); assert.equal(metric.missing, 1);
});
for (const units of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) test(`progress metrics: cost bound ${units}`, () => {
  const b = fixture().accepted().emit('execution-cost-finalized', { acceptanceId: 'acceptance1', units, unit: scope.costUnit, ...proof });
  if (units === 0) assert.equal(b.run().metrics.acceptedOutcomesPerCostUnit.value, null); else refused(b);
});
test('progress metrics: reject mixed cost units and mismatched acceptance', () => {
  for (const [key, value] of [['unit', 'different-unit'], ['acceptanceId', 'other']]) {
    const b = fixture().accepted().emit('execution-cost-finalized', { acceptanceId: 'acceptance1', units: 4, unit: scope.costUnit, ...proof });
    b.events.at(-1).data[key] = value; refused(b);
  }
});
test('progress metrics: aggregate costs cannot overflow a safe integer', () => {
  const b = fixture().accepted().emit('execution-cost-finalized', { acceptanceId: 'acceptance1', units: Number.MAX_SAFE_INTEGER, unit: scope.costUnit, ...proof });
  b.id = 'work2'; b.accepted().emit('execution-cost-finalized', { acceptanceId: 'acceptance1', units: 1, unit: scope.costUnit, ...proof }); refused(b);
});
test('progress metrics: defect rate requires an explicitly closed fixed observation window', () => {
  const b = fixture().verified(); const verifiedAt = b.now;
  assert.equal(b.run().metrics.escapedDefectRate.value, null);
  b.emit('defect-recorded', { deploymentId: 'dep1', defectId: 'd1', detectedAtMs: verifiedAt + 50, ...proof });
  b.now = verifiedAt + scope.defectWindowMs;
  b.emit('defect-window-closed', { deploymentId: 'dep1', throughMs: verifiedAt + scope.defectWindowMs, ...proof });
  assert.equal(b.run().metrics.escapedDefectRate.value, 1);
});
test('progress metrics: a zero defect rate is supported only by closed observation evidence', () => {
  const b = fixture().verified(); const verifiedAt = b.now; b.now += scope.defectWindowMs;
  b.emit('defect-window-closed', { deploymentId: 'dep1', throughMs: verifiedAt + scope.defectWindowMs, ...proof });
  assert.equal(b.run().metrics.escapedDefectRate.value, 0);
  b.emit('defect-recorded', { deploymentId: 'dep1', defectId: 'late-record', detectedAtMs: verifiedAt + 50, ...proof });
  assert.equal(b.run().metrics.escapedDefectRate.value, 1);
});
test('progress metrics: defects outside the fixed half-open window do not change its numerator', () => {
  const b = fixture().verified(); const end = b.now + scope.defectWindowMs; b.now = end;
  b.emit('defect-window-closed', { deploymentId: 'dep1', throughMs: end, ...proof });
  b.emit('defect-recorded', { deploymentId: 'dep1', defectId: 'outside', detectedAtMs: end, ...proof });
  assert.equal(b.run().metrics.escapedDefectRate.value, 0);
});
test('progress metrics: premature and shortened defect windows fail closed', () => {
  for (const offset of [0, scope.defectWindowMs]) {
    const b = fixture().verified(); b.emit('defect-window-closed', { deploymentId: 'dep1', throughMs: b.now + offset, ...proof }); refused(b);
  }
});
test('progress metrics: a second open deployment window makes an overall defect rate unknown', () => {
  const b = fixture().verified(); const end = b.now + scope.defectWindowMs; b.now = end;
  b.emit('defect-window-closed', { deploymentId: 'dep1', throughMs: end, ...proof });
  b.deploy('production', 'dep2').verify(); const m = b.run().metrics.escapedDefectRate;
  assert.equal(m.value, null); assert.equal(m.denominator, 1); assert.equal(m.missing, 1);
});

test('progress: staging cannot replace or erase a still-active production deployment', () => {
  const b = fixture().verified().deploy('staging', 'staging1');
  assert.equal(b.run().productionVerified, true); assert.equal(current(b).deployment.deploymentId, 'dep1');
  assert.equal(current(b).activeDeployments.length, 2);
  b.emit('deployment-ended', { ...b.dep, ...proof }); assert.equal(b.run().productionVerified, true);
});
test('progress: staging health can be verified while production remains the primary display', () => {
  const b = fixture().verified().deploy('staging', 'staging1').verify();
  assert.equal(current(b).activeDeployments.every(d => d.verified), true);
  assert.equal(b.run().metrics.escapedDefectRate.missing, 1);
});
test('progress: all children verified still requires an explicit coordinator goal decision', () => {
  const b = fixture().verified(); assert.deepEqual(b.run().pendingGoalActions,
    [{ ownerRole: 'coordinator', decision: 'confirm-goal' }]); assert.equal(b.run().goalComplete, false);
});
test('progress: post-merge changes need a new assignment, not a rewritten delivered identity', () => {
  const b = fixture().merged(); b.revision.headOid = 'f'.repeat(40); b.emit('revision-changed', { revision: b.revision }); refused(b);
});
