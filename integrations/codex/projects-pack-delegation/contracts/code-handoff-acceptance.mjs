import sourceSchema from './worker-handoff.schema.json' with { type: 'json' };

// Capture the base contract, rather than exporting its mutable module object.
const handoffV1 = structuredClone(sourceSchema);
const assignmentFields = ['packId', 'workerId', 'verificationCommand'];

// An explicit ECMAScript whitespace set avoids differences between validators'
// implementations of \s (notably for U+FEFF). This is a nonblank check, not proof
// that evidence is meaningful or that a reported command actually ran.
const nonblankPattern = '[^\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';

export const CODE_HANDOFF_V1_COMMAND_MAX_LENGTH =
  handoffV1.properties.tests.items.properties.command.maxLength;

function invalidAssignment(code, field) {
  const error = new TypeError(`Invalid trusted code assignment: ${field}.`);
  error.code = code;
  // Never echo command text: even a mistakenly supplied secret must not be
  // reflected into a validation-error message.
  return error;
}

function requireCanonicalString(value, field, maxLength) {
  if (typeof value !== 'string' || !value || value.trim() !== value
      || /[\u0000\r\n\u2028\u2029]/u.test(value)) {
    throw invalidAssignment('invalid_assignment', field);
  }
  // JSON Schema lengths count Unicode code points, not UTF-16 code units.
  // Reject oversized values before iteration; valid code points take <=2 units.
  if (value.length > maxLength * 2 || [...value].length > maxLength) {
    throw invalidAssignment(
      field === 'verificationCommand' ? 'verification_command_too_long' : 'invalid_assignment',
      field
    );
  }
}

/**
 * Build a Draft 2020-12 acceptance schema for one completed code assignment.
 *
 * @param {{packId: string, workerId: string, verificationCommand: string}} assignment
 *   Canonical JSON data read from the trusted assignment store, never derived
 *   from the worker's handoff. Do not include tokens or command-line secrets.
 * @returns {object} A fresh, self-contained JSON Schema. Validate the complete
 *   handoff with a standards-compliant Draft 2020-12 validator without coercion,
 *   defaults, or removal of unknown properties. This function does NOT validate
 *   a handoff, authenticate evidence, execute commands, or accept work.
 * @throws {TypeError} If assignment identity or command is incompatible with v1.
 */
export function createCodeHandoffAcceptanceSchema(assignment) {
  if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(assignment))) {
    throw invalidAssignment('invalid_assignment', 'object');
  }
  const keys = Reflect.ownKeys(assignment);
  if (keys.length !== assignmentFields.length
      || assignmentFields.some((field) => !Object.hasOwn(assignment, field))) {
    throw invalidAssignment('invalid_assignment', 'fields');
  }
  // Accept inert JSON properties only; don't execute getters during validation.
  for (const field of assignmentFields) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(assignment, field), 'value')) {
      throw invalidAssignment('invalid_assignment', 'fields');
    }
  }
  const { packId, workerId, verificationCommand } = assignment;
  requireCanonicalString(packId, 'packId', handoffV1.properties.packId.maxLength);
  requireCanonicalString(workerId, 'workerId', handoffV1.properties.workerId.maxLength);
  requireCanonicalString(verificationCommand, 'verificationCommand', CODE_HANDOFF_V1_COMMAND_MAX_LENGTH);

  const schema = structuredClone(handoffV1);
  // Each assignment has different constants. Never reuse the base schema's ID
  // for these profiles or let a validator cache one assignment as another.
  delete schema.$id;
  schema.title = 'Completed code handoff acceptance for one trusted assignment';
  schema.$comment = 'Additional code-acceptance constraints; the Worker Handoff v1 wire format is unchanged. Passing validation is not reviewer acceptance or permission to deliver.';
  schema.allOf.push({
    type: 'object',
    properties: {
      packId: { const: packId },
      workerId: { const: workerId },
      status: { const: 'completed' },
      completionEvidence: { type: 'string', pattern: nonblankPattern },
      tests: {
        type: 'array',
        minItems: 1,
        contains: {
          type: 'object',
          required: ['command', 'passed'],
          properties: {
            command: { const: verificationCommand },
            passed: { const: true }
          }
        },
        minContains: 1
      }
    }
  });
  return schema;
}
