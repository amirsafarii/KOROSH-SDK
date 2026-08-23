/**
 * Tool-result representation — converts an execution outcome into the
 * standard internal message appended back into the conversation:
 *
 *   { role: 'tool', toolCallId, content }
 *
 * Kept in its own module so the loop stays format-free and a future
 * persistence layer can serialize results without touching loop code.
 */
import { ToolResultError } from '../errors.js';

/**
 * Build the internal tool message for one executed call.
 * @param {object} params
 * @param {string} params.toolCallId id echoed from the model's tool_call
 * @param {string} params.toolName registry name of the executed tool
 * @param {'success'|'error'} params.status executor outcome
 * @param {any} [params.output] tool output when status === 'success'
 * @param {Error} [params.error] typed framework error when status === 'error'
 * @returns {{role:'tool', toolCallId:string, content:string}}
 */
export function toToolMessage({ toolCallId, toolName, status, output, error }) {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    throw new ToolResultError('toToolMessage requires "toolCallId".', { toolName });
  }
  if (status !== 'success' && status !== 'error') {
    throw new ToolResultError(`toToolMessage requires status success|error, got "${status}".`, {
      toolCallId,
      toolName,
    });
  }

  const content =
    status === 'success'
      ? serializeSuccessOutput(output, { toolCallId, toolName })
      : serializeError(error);

  return Object.freeze({ role: 'tool', toolCallId, content });
}

/**
 * Normalize a successful tool return value to JSON-compatible data. Strings
 * are preserved as raw message content; every other value is JSON-cloned.
 */
export function normalizeToolOutput(output, { toolCallId, toolName } = {}) {
  if (typeof output === 'string') return output;
  if (output === null || typeof output === 'number' || typeof output === 'boolean') {
    return output;
  }
  if (output === undefined) return null;

  try {
    return JSON.parse(JSON.stringify(output));
  } catch (cause) {
    throw new ToolResultError('Tool output must be JSON-serializable.', {
      toolCallId,
      toolName,
      cause,
    });
  }
}

function serializeSuccessOutput(output, context) {
  const normalized = normalizeToolOutput(output, context);
  return typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
}

function serializeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ error: message });
}
