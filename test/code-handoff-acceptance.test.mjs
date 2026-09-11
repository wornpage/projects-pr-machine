import assert from 'node:assert/strict';
import { test } from 'node:test';
import baseSchema from '../integrations/codex/projects-pack-delegation/contracts/worker-handoff.schema.json' with { type: 'json' };
import {
  CODE_HANDOFF_V1_COMMAND_MAX_LENGTH,
  createCodeHandoffAcceptanceSchema
} from '../integrations/codex/projects-pack-delegation/contracts/code-handoff-acceptance.mjs';

const assignment = Object.freeze({
  packId: 'wp-02-code', workerId: 'worker-1', verificationCommand: 'npm run check'
});
const profile = (override = {}) => createCodeHandoffAcceptanceSchema({ ...assignment, ...override });
const rejectsAssignment = (value, code = 'invalid_assignment') => {
  assert.throws(() => createCodeHandoffAcceptanceSchema(value), (error) =>
    error instanceof TypeError && error.code === code);
};

test('uses the existing v1 command bound without widening the wire contract', () => {
  assert.equal(CODE_HANDOFF_V1_COMMAND_MAX_LENGTH, 500);
  assert.equal(profile().properties.tests.items.properties.command.maxLength, 500);
});

test('preserves all original structural and status rules', () => {
  const output = profile();
  const { $id, title, ...expected } = structuredClone(baseSchema);
  output.allOf.pop();
  delete output.title;
  delete output.$comment;
  assert.deepEqual(output, expected);
});

test('binds identity and completed status to the trusted assignment', () => {
  const p = profile().allOf.at(-1).properties;
  assert.deepEqual(p.packId, { const: assignment.packId });
  assert.deepEqual(p.workerId, { const: assignment.workerId });
  assert.deepEqual(p.status, { const: 'completed' });
});

test('requires at least one exact command match reported as passed', () => {
  const tests = profile().allOf.at(-1).properties.tests;
  assert.equal(tests.minItems, 1);
  assert.equal(tests.minContains, 1);
  assert.deepEqual(tests.contains.required, ['command', 'passed']);
  assert.deepEqual(tests.contains.properties, {
    command: { const: assignment.verificationCommand }, passed: { const: true }
  });
});

test('retains the global v1 rejection of any failed completed test', () => {
  assert.equal(profile().allOf[0].then.properties.tests.items.properties.passed.const, true);
});

test('nonblank evidence pattern agrees with ECMAScript whitespace', () => {
  const pattern = new RegExp(profile().allOf.at(-1).properties.completionEvidence.pattern, 'u');
  for (const value of ['', ' ', '\t\r\n', '\u00a0', '\u2003', '\ufeff', ' \ufeff\t']) {
    assert.equal(pattern.test(value), false, JSON.stringify(value));
  }
  for (const value of ['Verified regression cases.', '\n Evidence \n', '✓']) {
    assert.equal(pattern.test(value), true);
  }
});

test('does not reuse the base schema ID', () => assert.equal(Object.hasOwn(profile(), '$id'), false));

test('generated schemas cannot mutate subsequent schemas or their assignments', () => {
  const before = structuredClone(baseSchema);
  const first = profile();
  first.required.length = 0;
  first.allOf.at(-1).properties.packId.const = 'changed';
  assert.deepEqual(baseSchema, before);
  assert.equal(profile().required.length, baseSchema.required.length);
  assert.equal(profile().allOf.at(-1).properties.packId.const, assignment.packId);
  assert.equal(assignment.packId, 'wp-02-code');
});

for (const length of [1, 499, 500]) {
  test(`accepts a ${length}-character canonical command`, () => {
    assert.equal(profile({ verificationCommand: 'x'.repeat(length) })
      .allOf.at(-1).properties.tests.contains.properties.command.const.length, length);
  });
}
for (const length of [501, 600, 2000, 2001]) {
  test(`rejects a ${length}-character v1 command before a profile can be used`, () => {
    rejectsAssignment({ ...assignment, verificationCommand: 'x'.repeat(length) }, 'verification_command_too_long');
  });
}

test('counts supplementary Unicode code points rather than UTF-16 units', () => {
  assert.doesNotThrow(() => profile({ verificationCommand: '😀'.repeat(500) }));
  rejectsAssignment({ ...assignment, verificationCommand: '😀'.repeat(501) }, 'verification_command_too_long');
});

for (const command of ['', ' ', '\t', ' npm run check', 'npm run check ', 'a\nb', 'a\rb', 'a\0b', 'a\u2028b', 'a\u2029b']) {
  test(`rejects noncanonical command ${JSON.stringify(command)}`, () => {
    rejectsAssignment({ ...assignment, verificationCommand: command });
  });
}
for (const input of [null, undefined, [], 1, 'assignment', {}, { ...assignment, extra: true }]) {
  test(`rejects malformed assignment ${JSON.stringify(input)}`, () => rejectsAssignment(input));
}
for (const field of ['packId', 'workerId', 'verificationCommand']) {
  for (const value of [42, false, null, {}]) {
    test(`does not coerce ${field} ${JSON.stringify(value)}`, () => rejectsAssignment({ ...assignment, [field]: value }));
  }
}

test('checks identity bounds against the original schema', () => {
  assert.doesNotThrow(() => profile({ packId: 'p'.repeat(160), workerId: 'w'.repeat(120) }));
  rejectsAssignment({ ...assignment, packId: 'p'.repeat(161) });
  rejectsAssignment({ ...assignment, workerId: 'w'.repeat(121) });
});

test('does not invoke accessors in supplied assignment data', () => {
  const input = { ...assignment };
  let called = false;
  Object.defineProperty(input, 'verificationCommand', { get() { called = true; return 'x'; } });
  rejectsAssignment(input);
  assert.equal(called, false);
});

test('does not accept extra symbol keys', () => rejectsAssignment({ ...assignment, [Symbol('extra')]: true }));

test('error messages do not echo invalid command text', () => {
  assert.throws(() => profile({ verificationCommand: 'secret-do-not-log\n' }), (error) => {
    assert.equal(error.message.includes('secret-do-not-log'), false);
    return error.code === 'invalid_assignment';
  });
});

test('profiles for different assignments have no shared constants', () => {
  const a = profile();
  const b = profile({ packId: 'wp-03', verificationCommand: 'npm test' });
  assert.equal(a.allOf.at(-1).properties.packId.const, assignment.packId);
  assert.equal(b.allOf.at(-1).properties.packId.const, 'wp-03');
  assert.equal(b.allOf.at(-1).properties.tests.contains.properties.command.const, 'npm test');
});
