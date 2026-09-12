import assert from 'node:assert/strict';
import test from 'node:test';
import { captureData } from '../integrations/codex/projects-pack-delegation/contracts/readiness-data.mjs';

for (const [label, input] of [
  ['values', Array.from({ length: 4 }, () => 'x'.repeat(70000))],
  ['keys', Object.fromEntries(['a', 'b', 'c', 'd'].map(key => [key.repeat(70000), 0]))]
]) test(`readiness data budgets aggregate ${label} before serialization`, t => {
  const original = JSON.stringify; let serializations = 0;
  t.mock.method(JSON, 'stringify', (...args) => { serializations++; return original(...args); });
  assert.throws(() => captureData(input), { code: 'invalid_data' });
  assert.equal(serializations, 0, 'oversize data must refuse before full JSON allocation');
});
test('readiness data refuses malformed Unicode object keys', () => {
  assert.throws(() => captureData({ ['\ud800']: 1 }), { code: 'invalid_data' });
});
test('readiness data retains inclusive encoded JSON byte limit and control-character accounting', () => {
  assert.equal(captureData('x'.repeat(262142)).length, 262142);
  assert.throws(() => captureData('x'.repeat(262143)), { code: 'invalid_data' });
  assert.equal(captureData('\u0000'.repeat(43690)).length, 43690);
  assert.throws(() => captureData('\u0000'.repeat(43691)), { code: 'invalid_data' });
});
