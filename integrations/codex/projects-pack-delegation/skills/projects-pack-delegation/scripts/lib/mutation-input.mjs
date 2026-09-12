const common = ['repositoryRoot', 'packId'];
const review = [...common, 'reviewedHead', 'confirmReview', 'confirmOwner'];
const fields = {
  prepare: [...common, 'title', 'baseBranch', 'remote', 'verificationCommand'],
  finalize: common,
  abort: common,
  stack: ['repositoryRoot', 'packIds', 'baseBranch', 'remote'],
  authorize: review,
  'authorize-admin': [...review, 'reason', 'bypassedRequirements'],
  finish: common
};
const arrayFields = new Set(['packIds', 'bypassedRequirements']);

export class MutationInputError extends TypeError {
  constructor() {
    super('Lifecycle inputs must use own data properties with primitive values and primitive array entries.');
    this.name = 'MutationInputError';
    this.code = 'invalid_input';
  }
}

function primitive(value) {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    throw new MutationInputError();
  }
  return value;
}

function ownValue(object, key) {
  const property = Object.getOwnPropertyDescriptor(object, key);
  if (!property || !Object.hasOwn(property, 'value')) throw new MutationInputError();
  return property.value;
}

/** Capture supported fields, never retaining mutable input references.
 * Ordinary objects and dependency implementations are trusted; proxies and
 * global prototype modification are not a JavaScript security boundary.
 * Command-specific validation remains the public facade/core's responsibility.
 */
export function captureMutationInput(command, input) {
  if (!Object.hasOwn(fields, command) || !input || typeof input !== 'object'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new MutationInputError();
  }
  const captured = {};
  for (const key of fields[command]) {
    if (!Object.hasOwn(input, key)) {
      if (key in input) throw new MutationInputError();
      continue;
    }
    const value = ownValue(input, key);
    if (arrayFields.has(key) && Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index++) {
        items.push(primitive(ownValue(value, String(index))));
      }
      captured[key] = Object.freeze(items);
    } else captured[key] = primitive(value);
  }
  return Object.freeze(captured);
}
