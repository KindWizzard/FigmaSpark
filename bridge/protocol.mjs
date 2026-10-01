export const PROTOCOL = 1;
export const READ_COMMANDS = new Set([
  'ping', 'context', 'pages', 'overview', 'libraries', 'last-report', 'selection', 'snapshot', 'search', 'export', 'styles', 'variables', 'inspect', 'audit'
]);
export const UI_COMMANDS = new Set(['focus', 'report']);
export const WRITE_COMMANDS = new Set(['patch']);
export const COMMANDS = new Set([...READ_COMMANDS, ...UI_COMMANDS, ...WRITE_COMMANDS]);

export class SparkError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SparkError('INVALID_REQUEST', 'Expected a JSON object.');
  }
  if (!COMMANDS.has(input.command)) {
    throw new SparkError('UNKNOWN_COMMAND', `Unknown command: ${String(input.command)}`);
  }
  if (input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params))) {
    throw new SparkError('INVALID_PARAMS', 'params must be an object.');
  }
  const timeoutMs = input.timeoutMs ?? 20000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new SparkError('INVALID_TIMEOUT', 'timeoutMs must be between 100 and 120000.');
  }
  if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || input.sessionId.length > 100)) {
    throw new SparkError('INVALID_SESSION', 'Invalid sessionId.');
  }
  return { command: input.command, params: input.params ?? {}, timeoutMs, sessionId: input.sessionId };
}
