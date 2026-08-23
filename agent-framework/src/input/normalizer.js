import { InputError, NormalizationError } from '../errors.js';

/**
 * Internal message representation — the single conversation currency used by
 * the loop, adapters and the tool-result module:
 *
 *   { role: 'user' | 'assistant' | 'system' | 'tool', content: string,
 *     toolCallId?: string }
 *
 * InputNormalizer converts accepted public inputs into this shape WITHOUT
 * mutating the caller's objects.
 */
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/**
 * Normalize run input into an internal message list (fresh array, deep-copied
 * contents).
 *
 * Accepted forms:
 *   - string                        → one user message
 *   - [{role, content}]             → validated message array
 *   - { text | content | messages } → unwrapped accordingly
 */
export function normalizeInput(input) {
  if (typeof input === 'string') {
    if (input.trim().length === 0) {
      throw new InputError('Input string must not be empty.');
    }
    return [message('user', input)];
  }

  if (isPlainObject(input)) {
    if (Array.isArray(input.messages)) {
      return normalizeMessageArray(input.messages);
    }
    const text = input.text ?? input.content;
    if (typeof text === 'string') {
      if (text.trim().length === 0) {
        throw new InputError('Input text must not be empty.');
      }
      return [message(input.role ?? 'user', text)];
    }
  }

  if (Array.isArray(input)) {
    return normalizeMessageArray(input);
  }

  throw new InputError(
    'Input must be a string, a message array, or {text|content|messages}.',
    { received: describeReceived(input) },
  );
}

/** Validate + copy a caller-supplied message list. Never mutates `messages`. */
function normalizeMessageArray(messages) {
  if (messages.length === 0) {
    throw new InputError('Input message array must not be empty.');
  }
  return messages.map((entry, index) => normalizeMessage(entry, index));
}

function normalizeMessage(entry, index) {
  if (!isPlainObject(entry)) {
    throw new NormalizationError(`Message at index ${index} must be an object.`, {
      index,
      received: describeReceived(entry),
    });
  }
  const role = entry.role;
  if (typeof role !== 'string' || !ROLES.has(role)) {
    throw new NormalizationError(
      `Message at index ${index} has invalid role "${String(role)}".`,
      { index, allowedRoles: [...ROLES] },
    );
  }
  const content = entry.content;
  if (typeof content !== 'string') {
    throw new NormalizationError(
      `Message at index ${index} must carry string "content".`,
      { index, role },
    );
  }
  if (content.trim().length === 0) {
    throw new NormalizationError(`Message at index ${index} must have non-empty content.`, {
      index,
      role,
    });
  }
  const toolCallId = typeof entry.toolCallId === 'string' ? entry.toolCallId : null;
  if (role === 'tool') {
    if (toolCallId === null || toolCallId.length === 0) {
      throw new NormalizationError(
        `Tool message at index ${index} requires a non-empty "toolCallId".`,
        { index },
      );
    }
  }
  return message(role, content, toolCallId);
}

/** Frozen internal message; toolCallId present only for tool messages. */
function message(role, content, toolCallId = null) {
  return Object.freeze(
    toolCallId !== null ? { role, content, toolCallId } : { role, content },
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeReceived(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
