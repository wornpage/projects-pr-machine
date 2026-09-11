import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCodeHandoffAcceptanceSchema } from '../../../contracts/code-handoff-acceptance.mjs';
import { createCodeReviewSnapshot } from './code-review-snapshot.mjs';

export const MAX_REVIEW_BYTES = 262144;
const DIGEST = /^[0-9a-f]{64}$/u;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && value.isWellFormed();
const digest = value => typeof value === 'string' && DIGEST.test(value);
const oid = value => typeof value === 'string' && OID.test(value);
const array = (value, max) => Array.isArray(value) && value.length <= max;
const relativePath = value => text(value, 1000) && [...value].length <= 500
  && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value)
  && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const paths = value => array(value, 256) && value.every(relativePath)
  && new Set(value).size === value.length;

class ReviewRefusal extends Error {
  constructor(code) { super(`Code review report refused: ${code}.`); this.code = code; }
}
const requireThat = (condition, code) => { if (!condition) throw new ReviewRefusal(code); };

// JSON.parse checks grammar first. This second pass rejects duplicate (including
// escaped-equivalent) object keys that could conceal contradictory review data.
function parseEnvelope(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new ReviewRefusal('invalid_json'); }
  const containers = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') {
      const start = i++;
      while (raw[i] !== '"') { if (raw[i] === '\\') i++; i++; }
      let next = i + 1;
      while (/\s/u.test(raw[next] ?? '') && next < raw.length) next++;
      if (raw[next] === ':') {
        const key = JSON.parse(raw.slice(start, i + 1)), seen = containers.at(-1);
        requireThat(seen instanceof Set && !seen.has(key), 'duplicate_key');
        seen.add(key);
      }
    } else if (char === '{' || char === '[') {
      containers.push(char === '{' ? new Set() : null);
      requireThat(containers.length <= 8, 'input_too_deep');
    } else if (char === '}' || char === ']') containers.pop();
  }
  return value;
}

/**
 * Validate a coordinator-built JSON envelope and recapture its pinned Git state.
 * The capture seam is trusted test code, never a CLI option or envelope field.
 * Success checks consistency of claims; it does not authenticate their author.
 */
export async function checkCodeReviewReport(raw, { capture = createCodeReviewSnapshot } = {}) {
  requireThat(typeof raw === 'string' && raw.length > 0
    && Buffer.byteLength(raw, 'utf8') <= MAX_REVIEW_BYTES && raw.isWellFormed(), 'invalid_input');
  const envelope = parseEnvelope(raw);
  requireThat(exact(envelope, ['assignment', 'report']), 'invalid_envelope');
  const { assignment, report } = envelope;
  requireThat(exact(assignment, ['repositoryRoot', 'baseOid', 'headOid', 'packId', 'workerId',
    'verificationCommand', 'expectedContextSha256'])
    && text(assignment.repositoryRoot, 4096) && path.isAbsolute(assignment.repositoryRoot)
    && oid(assignment.baseOid) && oid(assignment.headOid)
    && assignment.baseOid.length === assignment.headOid.length
    && digest(assignment.expectedContextSha256)
    && ['packId', 'workerId', 'verificationCommand'].every(key => text(assignment[key], 1000)), 'invalid_assignment');
  try {
    createCodeHandoffAcceptanceSchema({ packId: assignment.packId, workerId: assignment.workerId,
      verificationCommand: assignment.verificationCommand });
  } catch { throw new ReviewRefusal('invalid_assignment'); }
  requireThat(exact(report, ['recommendation', 'reviewedContextSha256', 'baseOid', 'headOid',
    'filesReviewed', 'findings', 'evidenceChecked', 'limitations', 'reviewNote']), 'invalid_report');
  requireThat(['accept', 'rework'].includes(report.recommendation), 'invalid_recommendation');
  // Incomplete rework templates may have null revision fields. They cannot pass.
  requireThat(report.recommendation === 'accept', 'review_requires_rework');
  requireThat(digest(report.reviewedContextSha256) && oid(report.baseOid) && oid(report.headOid)
    && text(report.reviewNote) && paths(report.filesReviewed)
    && array(report.findings, 128) && array(report.evidenceChecked, 64)
    && array(report.limitations, 64) && report.limitations.every(item => text(item)), 'invalid_report');
  requireThat(report.baseOid === assignment.baseOid && report.headOid === assignment.headOid
    && report.reviewedContextSha256 === assignment.expectedContextSha256, 'review_context_mismatch');
  for (const finding of report.findings) {
    requireThat(exact(finding, ['path', 'location', 'severity', 'blocking', 'impact', 'correction'])
      && relativePath(finding.path) && (finding.location === null || text(finding.location, 500))
      && ['info', 'low', 'medium', 'high', 'critical'].includes(finding.severity)
      && typeof finding.blocking === 'boolean' && text(finding.impact) && text(finding.correction),
    'invalid_finding');
  }
  for (const evidence of report.evidenceChecked) {
    requireThat(exact(evidence, ['origin', 'description'])
      && ['worker-reported', 'independently-observed'].includes(evidence.origin)
      && text(evidence.description), 'invalid_evidence');
  }
  requireThat(report.limitations.length === 0, 'unresolved_limitations');
  requireThat(!report.findings.some(item => item.blocking || ['high', 'critical'].includes(item.severity)),
    'blocking_findings');
  requireThat(report.evidenceChecked.some(item => item.origin === 'independently-observed'),
    'missing_independent_evidence');
  // Only the coordinator supplies these inputs from its original saved snapshot.
  // Never recapture without the original digest merely to make a changed review pass.
  let snapshot;
  try { snapshot = await capture(assignment); }
  catch { throw new ReviewRefusal('snapshot_refused'); }
  requireThat(object(snapshot) && snapshot.kind === 'code-review-snapshot' && snapshot.schemaVersion === 1
    && snapshot.contextSha256 === assignment.expectedContextSha256
    && snapshot.baseOid === assignment.baseOid && snapshot.headOid === assignment.headOid
    && snapshot.packId === assignment.packId && snapshot.workerId === assignment.workerId
    && snapshot.verificationCommandSha256 === sha256(assignment.verificationCommand)
    && array(snapshot.files, 256) && snapshot.files.length > 0
    && snapshot.files.every(item => exact(item, ['status', 'path'])
      && ['A', 'D', 'M', 'T'].includes(item.status) && relativePath(item.path)), 'invalid_snapshot');
  const changed = snapshot.files.map(item => item.path);
  requireThat(new Set(changed).size === changed.length, 'invalid_snapshot');
  requireThat(changed.length === report.filesReviewed.length
    && changed.every(file => report.filesReviewed.includes(file)), 'incomplete_coverage');
  // No report prose, paths, command text, or assignment IDs in the receipt.
  return { kind: 'code-review-report-check', schemaVersion: 1, status: 'validated',
    baseOid: snapshot.baseOid, headOid: snapshot.headOid, contextSha256: snapshot.contextSha256,
    reportSha256: sha256(JSON.stringify(report)), filesReviewed: changed.length,
    findings: report.findings.length, evidenceItems: report.evidenceChecked.length };
}

/** Read only stdin, with a total byte cap and a deadline to receive EOF. */
export async function readReviewInput(input, { timeoutMs = 10000 } = {}) {
  requireThat(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000, 'invalid_timeout');
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => input.destroy(new ReviewRefusal('input_timeout')), timeoutMs);
  try {
    for await (const chunk of input) {
      requireThat(Buffer.isBuffer(chunk), 'invalid_input');
      bytes += chunk.length;
      requireThat(bytes <= MAX_REVIEW_BYTES, 'input_too_large');
      chunks.push(chunk);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { throw new ReviewRefusal('invalid_utf8'); }
  } catch (error) {
    throw error instanceof ReviewRefusal ? error : new ReviewRefusal('input_read_failed');
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    requireThat(process.argv.length === 2, 'invalid_arguments');
    console.log(JSON.stringify(await checkCodeReviewReport(await readReviewInput(process.stdin))));
  } catch (error) {
    const code = error instanceof ReviewRefusal ? error.code : 'report_check_failed';
    console.log(JSON.stringify({ kind: 'code-review-report-check', status: 'refused', error: code }));
    process.exitCode = 1;
  }
}
