import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedCodeAcceptance }
  from '../integrations/codex/projects-pack-delegation/contracts/hosted-code-acceptance.mjs';
import { captureData, dataDigest, sha256 }
  from '../integrations/codex/projects-pack-delegation/contracts/readiness-data.mjs';

// Deliberately an in-memory SERIALIZABLE adapter fixture, not a production DB.
function fixture() {
  const f = { principal: { tenantId: 'tenant-a', actorId: 'coordinator', sessionId: 'session-a' },
    request: { assignmentId: 'a1', expectedVersion: 1, idempotencyKey: 'request-1', handoff: {
      schemaVersion: 1, packId: 'p1', workerId: 'w1', status: 'completed', filesChanged: ['proof.txt'],
      tests: [{ command: 'npm run check', passed: true, note: null }], summary: 'Complete',
      blocker: null, completionEvidence: 'Fixture evidence', createdAt: '2026-09-11T00:00:00.000Z' } },
    assignment: { id: 'a1', tenantId: 'tenant-a', kind: 'code', status: 'submitted', version: 1,
      repository: 'fixture/rehearsal', packId: 'p1', workerId: 'w1', workerActorId: 'worker',
      workerGitHubIds: [11], baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
      contextSha256: 'c'.repeat(64), verificationCommand: 'npm run check' },
    policy: { reviewerIds: [22], runnerIds: ['actions:123'] },
    permitted: true, validations: 0, commits: 0, audit: [], replays: new Map(), lost: false, conflict: false };
  const tuple = () => ({ repository: f.assignment.repository, baseOid: f.assignment.baseOid, headOid: f.assignment.headOid });
  f.review = { ...tuple(), status: 'validated', contextSha256: f.assignment.contextSha256,
    reportValidated: true, reviewerIds: [22], reportSha256: 'd'.repeat(64) };
  f.execution = { ...tuple(), passed: true, runnerId: 'actions:123',
    commandSha256: sha256(f.assignment.verificationCommand), artifactSha256: 'e'.repeat(64) };
  f.current = { ...tuple(), contextSha256: f.assignment.contextSha256 };
  let queue = Promise.resolve();
  f.store = { async transaction(scope, work) {
    const previous = queue; let release; queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const tx = {
        authorize: async principal => f.permitted && principal.sessionId !== 'revoked'
          && principal.tenantId === f.assignment.tenantId && scope.tenantId === f.assignment.tenantId
          && scope.assignmentId === f.assignment.id && ['coordinator', 'worker'].includes(principal.actorId),
        getAssignment: async () => f.assignment,
        getIdempotency: async (actor, key) => f.replays.get(`${actor}/${key}`) ?? null,
        commitAcceptance: async record => {
          if (f.conflict || record.expectedVersion !== f.assignment.version) return false;
          f.commits++; f.assignment = { ...f.assignment, status: 'accepted', version: record.receipt.version };
          f.audit.push(record.event); f.replays.set(`${record.idempotency.actorId}/${record.idempotency.key}`, record.idempotency);
          if (f.lost) { f.lost = false; throw new Error('PRIVATE commit response lost'); }
          return true;
        }
      };
      const result = await work(tx);
      if (f.lostOuter) { f.lostOuter = false; throw new Error('PRIVATE transaction response lost'); }
      return result;
    } finally { release(); }
  } };
  f.adapters = { store: f.store,
    // This seam checks schema selection/identity, NOT complete JSON Schema semantics.
    // The repository's handoff-semantics job separately runs the real validator.
    validateHandoff: async (schema, handoff) => {
      f.validations++;
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.equal(schema.allOf.at(-1).properties.packId.const, 'p1');
      return handoff.status === 'completed' && handoff.tests[0]?.command === 'npm run check';
    },
    readReview: async () => f.review, readVerification: async () => f.execution,
    observeRevision: async () => f.current };
  f.accept = () => createHostedCodeAcceptance(f.adapters, f.policy);
  return f;
}
const reject = (f, code, accept = f.accept()) => assert.rejects(accept(f.principal, f.request), e => {
  assert.equal(e.code, code); assert.ok(!JSON.stringify(e).includes('PRIVATE')); return true;
});

test('hosted acceptance: one atomic outcome/audit, exact replay and renewed session', async () => {
  const f = fixture(); const accept = f.accept();
  const receipt = await accept(f.principal, f.request);
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.version, 2);
  assert.equal(f.commits, 1); assert.equal(f.audit.length, 1);
  assert.equal(receipt.handoffSha256, dataDigest(f.request.handoff));
  assert.equal(f.audit[0].receiptSha256, dataDigest(receipt));
  assert.deepEqual(await accept({ ...f.principal, sessionId: 'renewed' }, f.request), receipt);
  assert.equal(f.commits, 1); assert.equal(f.validations, 1);
  assert.ok(!JSON.stringify(receipt).includes('npm run check'));
});
for (const lost of ['lost', 'lostOuter']) test(`hosted acceptance: ${lost} commit response is unknown then replayed once`, async () => {
  const f = fixture(); f[lost] = true; const accept = f.accept();
  await reject(f, 'acceptance_outcome_unknown', accept);
  assert.equal(f.commits, 1); assert.equal((await accept(f.principal, f.request)).status, 'accepted');
  assert.equal(f.commits, 1); assert.equal(f.audit.length, 1);
});

test('hosted acceptance: concurrent identical requests commit once', async () => {
  const f = fixture(); const accept = f.accept();
  const receipts = await Promise.all(Array.from({ length: 8 }, () => accept(f.principal, f.request)));
  assert.ok(receipts.every(receipt => dataDigest(receipt) === dataDigest(receipts[0])));
  assert.equal(f.commits, 1); assert.equal(f.audit.length, 1);
});
test('hosted acceptance: competing keys/versions cannot multiply acceptance', async () => {
  const f = fixture(); const accept = f.accept();
  const results = await Promise.allSettled([accept(f.principal, f.request),
    accept(f.principal, { ...f.request, idempotencyKey: 'another' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.commits, 1);
});
test('hosted acceptance: reused key with different evidence conflicts', async () => {
  const f = fixture(); const accept = f.accept(); await accept(f.principal, f.request);
  f.request.handoff.summary = 'Different'; await reject(f, 'idempotency_conflict', accept);
  assert.equal(f.commits, 1);
});
for (const [label, change, code] of [
  ['cross tenant', f => { f.principal.tenantId = 'tenant-b'; }, 'acceptance_forbidden'],
  ['revoked session', f => { f.principal.sessionId = 'revoked'; }, 'acceptance_forbidden'],
  ['worker acceptance', f => { f.principal.actorId = 'worker'; }, 'worker_self_acceptance'],
  ['stale version', f => { f.request.expectedVersion = 0; }, 'stale_assignment'],
  ['noncode path', f => { f.assignment.kind = 'non-code'; }, 'stale_assignment'],
  ['failed handoff', f => { f.request.handoff.status = 'failed'; }, 'invalid_handoff'],
  ['false validator', f => { f.adapters.validateHandoff = async () => ({ valid: true }); }, 'invalid_handoff'],
  ['self review', f => { f.review.reviewerIds = [11]; }, 'independent_review_required'],
  ['allowlisted worker', f => { f.policy.reviewerIds = [11]; f.review.reviewerIds = [11]; }, 'independent_review_required'],
  ['unknown reviewer', f => { f.review.reviewerIds = [23]; }, 'independent_review_required'],
  ['missing review', f => { f.review.reviewerIds = []; }, 'independent_review_required'],
  ['stale review', f => { f.review.headOid = 'f'.repeat(40); }, 'independent_review_required'],
  ['unchecked report', f => { f.review.reportValidated = false; }, 'independent_review_required'],
  ['failed verification', f => { f.execution.passed = false; }, 'verification_required'],
  ['unknown runner', f => { f.execution.runnerId = 'worker'; }, 'verification_required'],
  ['wrong command', f => { f.execution.commandSha256 = '0'.repeat(64); }, 'verification_required'],
  ['missing artifact', f => { f.execution.artifactSha256 = ''; }, 'verification_required'],
  ['moved head', f => { f.current.headOid = 'f'.repeat(40); }, 'stale_revision'],
  ['moved base', f => { f.current.baseOid = 'f'.repeat(40); }, 'stale_revision'],
  ['changed context', f => { f.current.contextSha256 = 'f'.repeat(64); }, 'stale_revision'],
  ['version CAS refused', f => { f.conflict = true; }, 'acceptance_conflict']
]) test(`hosted acceptance refuses ${label} without a commit`, async () => {
  const f = fixture(); change(f); await reject(f, code); assert.equal(f.commits, 0); assert.deepEqual(f.audit, []);
});
test('hosted acceptance: revocation during observation and before a replay is respected', async () => {
  const f = fixture(); f.adapters.observeRevision = async () => { f.permitted = false; return f.current; };
  await reject(f, 'acceptance_forbidden'); assert.equal(f.commits, 0);
  const g = fixture(); const accept = g.accept(); await accept(g.principal, g.request);
  g.permitted = false; await reject(g, 'acceptance_forbidden', accept); assert.equal(g.commits, 1);
});
test('hosted acceptance: all request/policy/adapter references are captured', async () => {
  const f = fixture(); const original = f.adapters.readReview;
  f.adapters.validateHandoff = async () => {
    f.principal.actorId = 'worker'; f.request.assignmentId = 'other';
    f.request.handoff.summary = 'PRIVATE replacement'; f.policy.reviewerIds[0] = 99;
    f.adapters.readReview = async () => { throw Error('PRIVATE'); }; return true;
  };
  const receipt = await f.accept()(f.principal, f.request);
  assert.equal(receipt.actorId, 'coordinator'); assert.equal(receipt.assignmentId, 'a1');
  assert.notEqual(receipt.handoffSha256, dataDigest(f.request.handoff)); assert.equal(f.commits, 1);
  assert.equal(typeof original, 'function');
});
test('hosted acceptance: adapter errors stay bounded and no adapter is optional', async () => {
  const f = fixture(); f.adapters.readReview = async () => { throw Error('PRIVATE'); };
  await reject(f, 'acceptance_unavailable'); assert.equal(f.commits, 0);
  for (const key of Object.keys(f.adapters)) {
    const missing = { ...f.adapters }; delete missing[key];
    assert.throws(() => createHostedCodeAcceptance(missing, f.policy), { code: 'missing_adapter' });
  }
});
test('readiness data: deterministic, detached, bounded inert JSON only', () => {
  assert.equal(dataDigest({ b: 1, a: 2 }), dataDigest({ a: 2, b: 1 }));
  let reads = 0;
  for (const value of [{ get secret() { reads++; return 'PRIVATE'; } }, { x: undefined },
    { x: NaN }, { x: '\ud800' }, new Array(1), { x: () => {} }, { x: new Date() }, 'a'.repeat(262145)]) {
    assert.throws(() => captureData(value), { code: 'invalid_data' });
  }
  assert.equal(reads, 0);
  const source = { a: [1] }; const captured = captureData(source); source.a[0] = 2;
  assert.deepEqual(captured, { a: [1] }); assert.ok(Object.isFrozen(captured.a));
  const cycle = {}; cycle.self = cycle; assert.throws(() => captureData(cycle), { code: 'invalid_data' });
});

test('hosted acceptance: damaged saved receipts cannot become successful replays', async () => {
  const f = fixture(); const accept = f.accept(); await accept(f.principal, f.request);
  const saved = f.replays.get('coordinator/request-1');
  saved.receipt = { ...saved.receipt, headOid: 'f'.repeat(40) };
  await reject(f, 'invalid_saved_receipt', accept); assert.equal(f.commits, 1);
});
