import assert from 'node:assert/strict';
import test from 'node:test';
import { newPlanVerificationCommand, VerificationCommandError }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/verification-command.mjs';
import { CODE_HANDOFF_V1_COMMAND_MAX_LENGTH, createCodeHandoffAcceptanceSchema }
  from '../integrations/codex/projects-pack-delegation/contracts/code-handoff-acceptance.mjs';

const accepted = [
  ['one character', 'x'], ['499 ASCII', 'x'.repeat(499)], ['500 ASCII', 'x'.repeat(500)],
  ['250 supplementary', '😀'.repeat(250)], ['500 supplementary', '😀'.repeat(500)],
  ['mixed 500 code points', `x${'😀'.repeat(499)}`], ['combining sequence', 'echo e\u0301'],
  ['interior tab', 'echo\tx'], ['literal shell operators', 'echo "$HOME"; printf "%s" "$(date)"']
];
for (const [label, value] of accepted) {
  test(`new verification command: preserves ${label} exactly and fits the handoff profile`, () => {
    const input = Object.freeze({ verificationCommand: value });
    assert.equal(newPlanVerificationCommand(input), value);
    const profile = createCodeHandoffAcceptanceSchema({ packId: 'pack', workerId: 'worker', verificationCommand: value });
    assert.equal(profile.allOf.at(-1).properties.tests.contains.properties.command.const, value);
  });
}

test('new verification command: maximum agrees with the existing v1 wire contract', () => {
  assert.equal(CODE_HANDOFF_V1_COMMAND_MAX_LENGTH, 500);
  assert.throws(() => newPlanVerificationCommand({ verificationCommand: 'x'.repeat(501) }), VerificationCommandError);
});

const refused = [
  ['missing', undefined], ['null', null], ['number', 42], ['boolean', true], ['array', ['echo x']],
  ['object', {}], ['boxed string', new String('echo x')], ['symbol', Symbol('PRIVATE_COMMAND')],
  ['empty', ''], ['blank', ' \t '], ['leading space', ' echo x'], ['trailing space', 'echo x '],
  ['leading BOM', '\ufeffecho x'], ['trailing NBSP', 'echo x\u00a0'],
  ['NUL', 'echo\0x'], ['CR', 'echo\rx'], ['LF', 'echo\nx'],
  ['Unicode line separator', 'echo\u2028x'], ['Unicode paragraph separator', 'echo\u2029x'],
  ['lone high surrogate', 'echo\ud800'], ['lone low surrogate', '\udc00echo'],
  ['reversed surrogate pair', '\udc00\ud800'], ['501 ASCII', 'x'.repeat(501)],
  ['600 ASCII', 'x'.repeat(600)], ['2000 ASCII', 'x'.repeat(2000)],
  ['2001 ASCII', 'x'.repeat(2001)], ['501 supplementary', '😀'.repeat(501)],
  ['500 graphemes but 1000 code points', 'e\u0301'.repeat(500)], ['bounded oversized', 'x'.repeat(100000)]
];
for (const [label, value] of refused) {
  test(`new verification command: refuses ${label} without coercing or reflecting the input`, () => {
    assert.throws(() => newPlanVerificationCommand({ verificationCommand: value }), error => {
      assert.ok(error instanceof VerificationCommandError);
      assert.equal(error.code, 'invalid_input');
      assert.match(error.message, /1-500 code points/u);
      assert.ok(!error.message.includes('PRIVATE_COMMAND'));
      assert.ok(error.message.length < 250);
      return true;
    });
  });
}

test('new verification command: does not execute getters or string-conversion hooks', () => {
  let calls = 0;
  for (const input of [
    { get verificationCommand() { calls++; throw new Error('PRIVATE_COMMAND'); } },
    { verificationCommand: { toString() { calls++; return 'echo x'; } } },
    Object.create({ get verificationCommand() { calls++; return 'echo x'; } })
  ]) assert.throws(() => newPlanVerificationCommand(input), VerificationCommandError);
  assert.equal(calls, 0);
});

test('new verification command: requires an own data property on an object', () => {
  for (const input of [null, undefined, false, 42, 'echo x', [], {}, Object.create({ verificationCommand: 'echo x' })]) {
    assert.throws(() => newPlanVerificationCommand(input), VerificationCommandError);
  }
  const input = Object.create(null);
  Object.defineProperty(input, 'verificationCommand', { value: 'echo x', enumerable: false });
  assert.equal(newPlanVerificationCommand(input), 'echo x');
});

test('new verification command: no Unicode normalization or secret-bearing diagnostic output', () => {
  assert.notEqual(newPlanVerificationCommand({ verificationCommand: 'echo é' }),
    newPlanVerificationCommand({ verificationCommand: 'echo e\u0301' }));
  assert.throws(() => newPlanVerificationCommand({ verificationCommand: ` PRIVATE_COMMAND${'x'.repeat(600)}` }),
    error => !String(error).includes('PRIVATE_COMMAND') && error.code === 'invalid_input');
});
