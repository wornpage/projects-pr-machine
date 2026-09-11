import { CODE_HANDOFF_V1_COMMAND_MAX_LENGTH }
  from '../../../../contracts/code-handoff-acceptance.mjs';

export class VerificationCommandError extends TypeError {
  constructor() {
    super(`verificationCommand must be a canonical single-line Unicode string of 1-${CODE_HANDOFF_V1_COMMAND_MAX_LENGTH} code points. Use a reviewed script for longer checks.`);
    this.name = 'VerificationCommandError';
    this.code = 'invalid_input';
  }
}

/** Read a new assignment's literal command without coercion or accessor calls.
 * This is compatibility validation, not a shell allowlist or proof of execution.
 * The caller and ordinary object operations are trusted, not an OS/JS sandbox.
 */
export function newPlanVerificationCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VerificationCommandError();
  }
  const property = Object.getOwnPropertyDescriptor(input, 'verificationCommand');
  const value = property && Object.hasOwn(property, 'value') ? property.value : undefined;
  if (typeof value !== 'string' || !value
      // Bound code-point iteration; supplementary characters take two units.
      || value.length > CODE_HANDOFF_V1_COMMAND_MAX_LENGTH * 2
      || value.trim() !== value || !value.isWellFormed()
      || /[\u0000\r\n\u2028\u2029]/u.test(value)
      || [...value].length > CODE_HANDOFF_V1_COMMAND_MAX_LENGTH) {
    // Never echo rejected command text, including accidental credentials.
    throw new VerificationCommandError();
  }
  return value;
}
