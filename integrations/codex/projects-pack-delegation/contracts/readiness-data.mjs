import { createHash } from 'node:crypto';

export class ReadinessError extends Error {
  constructor(code) {
    super('Readiness verification refused; inspect the error code.');
    this.name = 'ReadinessError';
    this.code = code;
  }
}
export function requireThat(condition, code) {
  if (!condition) throw new ReadinessError(code);
}
export const isOid = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
export const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const isId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/u.test(value);
export const isRepository = value => typeof value === 'string'
  && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
  && !value.split('/').some(part => part === '.' || part === '..');
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// Copy inert JSON data before any await. No getters, toJSON, coercion, or shared
// references. This is a bounded data contract, not a hostile-JavaScript sandbox.
export function captureData(value) {
  let nodes = 0; let textBytes = 0;
  function budgetText(text) {
    requireThat(text.length <= 262144 && text.isWellFormed(), 'invalid_data');
    textBytes += Buffer.byteLength(text, 'utf8');
    requireThat(textBytes <= 262144, 'invalid_data');
  }
  function copy(item, depth) {
    requireThat(++nodes <= 10000 && depth <= 32, 'invalid_data');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      requireThat(Number.isFinite(item), 'invalid_data');
      return item;
    }
    if (typeof item === 'string') {
      budgetText(item);
      return item;
    }
    requireThat(item && typeof item === 'object', 'invalid_data');
    const array = Array.isArray(item);
    requireThat(array || [Object.prototype, null].includes(Object.getPrototypeOf(item)), 'invalid_data');
    const keys = Reflect.ownKeys(item);
    requireThat(keys.length <= 4097 && keys.every(key => typeof key === 'string'), 'invalid_data');
    if (array) {
      requireThat(item.length <= 4096 && keys.length === item.length + 1, 'invalid_data');
      const result = [];
      for (let i = 0; i < item.length; i++) {
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        requireThat(property && Object.hasOwn(property, 'value'), 'invalid_data');
        result.push(copy(property.value, depth + 1));
      }
      return Object.freeze(result);
    }
    // Bound aggregate key/value text before sorting keys or allocating full JSON.
    // Final encoded-byte accounting below also covers escaping and punctuation.
    keys.forEach(budgetText);
    return Object.freeze(Object.fromEntries(keys.sort().map(key => {
      const property = Object.getOwnPropertyDescriptor(item, key);
      requireThat(Object.hasOwn(property, 'value'), 'invalid_data');
      return [key, copy(property.value, depth + 1)];
    })));
  }
  const result = copy(value, 0);
  requireThat(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 262144, 'invalid_data');
  return result;
}
export const dataDigest = value => sha256(JSON.stringify(captureData(value)));
export function exactKeys(value, keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'invalid_data');
}
