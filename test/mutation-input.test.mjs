import assert from 'node:assert/strict';
import test from 'node:test';
import { captureMutationInput, MutationInputError }
  from '../integrations/codex/projects-pack-delegation/skills/projects-pack-delegation/scripts/lib/mutation-input.mjs';

const cases = {
  prepare: { repositoryRoot: '/repo', packId: 'p', title: 'T', baseBranch: 'main', remote: 'origin', verificationCommand: 'npm test' },
  finalize: { repositoryRoot: '/repo', packId: 'p' },
  abort: { repositoryRoot: '/repo', packId: 'p' },
  stack: { repositoryRoot: '/repo', packIds: ['bottom', 'top'], baseBranch: 'main', remote: 'origin' },
  authorize: { repositoryRoot: '/repo', packId: 'p', reviewedHead: 'a'.repeat(40), confirmReview: false, confirmOwner: false },
  'authorize-admin': { repositoryRoot: '/repo', packId: 'p', reviewedHead: 'a'.repeat(40), confirmReview: true,
    confirmOwner: false, reason: 'Original reason', bypassedRequirements: ['github-ruleset:update'] },
  finish: { repositoryRoot: '/repo', packId: 'p' }
};

for (const [command, original] of Object.entries(cases)) {
  test(`mutation input: ${command} captures every consumed field without modifying its caller`, () => {
    const input = structuredClone(original);
    const captured = captureMutationInput(command, input);
    assert.deepEqual(input, original); assert.deepEqual(captured, original);
    assert.notEqual(captured, input); assert.ok(Object.isFrozen(captured));
    for (const key of Object.keys(input)) {
      if (Array.isArray(input[key])) {
        assert.notEqual(captured[key], input[key]); assert.ok(Object.isFrozen(captured[key]));
        input[key].reverse(); input[key].push('substituted');
      }
      input[key] = 'substituted';
    }
    assert.deepEqual(captured, original);
  });
  test(`mutation input: ${command} refuses consumed accessors without evaluating them`, () => {
    for (const key of Object.keys(original)) {
      let calls = 0;
      const input = structuredClone(original);
      Object.defineProperty(input, key, { get() { calls++; return 'PRIVATE'; } });
      assert.throws(() => captureMutationInput(command, input), MutationInputError);
      assert.equal(calls, 0);
    }
  });
}

test('mutation input: false, missing, and non-boolean confirmations are never promoted to approval', () => {
  for (const value of [false, undefined, null, 0, 1, 'true', 'false']) {
    const captured = captureMutationInput('authorize', { confirmOwner: value, confirmReview: value });
    assert.equal(captured.confirmOwner, value); assert.equal(captured.confirmReview, value);
  }
  assert.deepEqual(captureMutationInput('authorize', {}), {});
});

test('mutation input: primitive spellings are not trimmed, normalized, or coerced', () => {
  const input = { ...cases.prepare, packId: 17, verificationCommand: ' echo e\u0301\t ' };
  assert.deepEqual(captureMutationInput('prepare', input), input);
  assert.equal(captureMutationInput('authorize', { reviewedHead: 1n }).reviewedHead, 1n);
});

for (const value of [null, undefined, [], 1, 'input', () => {}, new Date(), Object.create({ packId: 'p' })]) {
  test(`mutation input: rejects non-record input (${typeof value}/${Array.isArray(value)})`, () => {
    assert.throws(() => captureMutationInput('finalize', value), MutationInputError);
  });
}

test('mutation input: null-prototype records and non-enumerable own data are captured', () => {
  const input = Object.create(null);
  Object.defineProperty(input, 'packId', { value: 'p' });
  assert.deepEqual(captureMutationInput('finalize', input), { packId: 'p' });
});

test('mutation input: unknown fields and their getters stay irrelevant', () => {
  let calls = 0;
  const input = { packId: 'p', get irrelevant() { calls++; throw new Error('PRIVATE'); } };
  assert.deepEqual(captureMutationInput('finalize', input), { packId: 'p' });
  assert.equal(calls, 0);
  for (const command of ['__proto__', 'constructor', 'doctor', 'status', 'invalid']) {
    assert.throws(() => captureMutationInput(command, input), MutationInputError);
  }
});

for (const [command, key] of [['stack', 'packIds'], ['authorize-admin', 'bypassedRequirements']]) {
  test(`mutation input: ${key} rejects sparse/accessor/reference entries without evaluation`, () => {
    let calls = 0;
    const accessor = ['p']; Object.defineProperty(accessor, '0', { get() { calls++; return 'PRIVATE'; } });
    const coercible = { toString() { calls++; return 'PRIVATE'; } };
    for (const value of [new Array(1), accessor, [coercible], [[]], [() => {}]]) {
      assert.throws(() => captureMutationInput(command, { [key]: value }), MutationInputError);
    }
    assert.equal(calls, 0);
  });
  test(`mutation input: ${key} preserves order and invalid primitive values for existing validation`, () => {
    for (const value of [false, undefined, null, 'not-an-array', 17]) {
      assert.equal(captureMutationInput(command, { [key]: value })[key], value);
    }
    assert.deepEqual(captureMutationInput(command, { [key]: ['z', 'a', 'z', null, 7] })[key], ['z', 'a', 'z', null, 7]);
  });
}

test('mutation input: mutable scalar references fail without coercion or secret-bearing diagnostics', () => {
  let calls = 0;
  for (const value of [{ toString() { calls++; return 'PRIVATE'; } }, new String('PRIVATE'), ['PRIVATE'], () => 'PRIVATE']) {
    assert.throws(() => captureMutationInput('finalize', { repositoryRoot: value }), error => {
      assert.ok(error instanceof MutationInputError); assert.equal(error.code, 'invalid_input');
      assert.ok(!String(error).includes('PRIVATE')); return true;
    });
  }
  assert.equal(calls, 0);
});
