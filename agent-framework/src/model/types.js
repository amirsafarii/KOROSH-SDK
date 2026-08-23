/**
 * Model adapter contract — the ONLY seam between Core and any LLM provider.
 *
 * An adapter is any object exposing:
 *
 *   async call(request, options) => NormalizedModelResult
 *
 * Request (produced by the loop, provider-agnostic):
 *   {
 *     instructions: string,        // agent's system-level instructions
 *     input: InternalMessage[],    // normalized conversation, incl. tool messages
 *     tools: ToolDescriptor[],     // [{name, description, parameters}]
 *     metadata: {                  // run-scoped correlation data
 *       runId, turnNumber, agentName, modelId
 *     }
 *   }
 *   options: { signal?: AbortSignal }
 *
 * NormalizedModelResult (the only result shape Core understands):
 *   {
 *     final: string | null,        // final text when the turn completes
 *     toolCalls: [{                // zero or more requested calls
 *       id: string,                // stable id echoed in the tool result message
 *       name: string,
 *       arguments: object          // parsed args object (never a raw JSON string)
 *     }],
 *     usage?: {inputTokens?, outputTokens?, totalTokens?, ...},
 *     metadata?: object            // pass-through: finishReason, raw refs, etc.
 *   }
 *
 * Validation of the returned shape happens in `assertModelResult` so a broken
 * adapter fails fast with a typed error instead of corrupting the loop.
 */
import { InvalidToolCallError, ModelResultError } from '../errors.js';

/** Structural guard applied to every adapter response before the loop consumes it. */
export function assertModelResult(result, context = {}) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new ModelResultError('Model adapter must return an object.', {
      ...context,
      received: describeType(result),
    });
  }

  const hasFinal = typeof result.final === 'string';
  const toolCalls = result.toolCalls;

  if (!hasFinal && !Array.isArray(toolCalls)) {
    throw new ModelResultError(
      'Model result must define "final" (string) and/or "toolCalls" (array).',
      { ...context, received: describeShape(result) },
    );
  }
  if (result.final !== undefined && result.final !== null && typeof result.final !== 'string') {
    throw new ModelResultError('"final" must be a string when present.', {
      ...context,
      received: describeType(result.final),
    });
  }
  if (toolCalls !== undefined && toolCalls !== null && !Array.isArray(toolCalls)) {
    throw new ModelResultError('"toolCalls" must be an array when present.', {
      ...context,
      received: describeType(toolCalls),
    });
  }

  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (!hasFinal && calls.length === 0) {
    throw new ModelResultError(
      'Model result must contain final text or at least one tool call.',
      { ...context },
    );
  }

  const seenIds = new Set();
  for (const call of calls) {
    assertToolCall(call, context, seenIds);
  }
  return result;
}

/**
 * Return a defensive core copy of a normalized result. Provider-specific
 * `usage` and `metadata` are passed through by reference; Core-owned fields
 * (`final`, `toolCalls[].arguments`) are copied so adapters cannot mutate run
 * state after returning.
 */
export function cloneNormalizedResult(result) {
  return {
    ...result,
    final: result.final,
    toolCalls: Array.isArray(result.toolCalls)
      ? result.toolCalls.map((call) => ({
          ...call,
          arguments: structuredClone(call.arguments),
        }))
      : result.toolCalls,
  };
}

function assertToolCall(call, context, seenIds) {
  const where = { ...context, toolCall: safeSummary(call) };
  if (call === null || typeof call !== 'object' || Array.isArray(call)) {
    throw new InvalidToolCallError('Each entry of "toolCalls" must be an object.', where);
  }
  if (typeof call.id !== 'string' || call.id.length === 0) {
    throw new InvalidToolCallError('Tool call requires a non-empty string "id".', where);
  }
  if (seenIds.has(call.id)) {
    throw new InvalidToolCallError(`Tool call id "${call.id}" is duplicated in one model result.`, where);
  }
  seenIds.add(call.id);
  if (typeof call.name !== 'string' || call.name.length === 0) {
    throw new InvalidToolCallError(`Tool call "${call.id}" requires a non-empty string "name".`, where);
  }
  if (call.arguments === undefined) {
    throw new InvalidToolCallError(
      `Tool call "${call.id}" requires "arguments" (use {} when absent).`,
      where,
    );
  }
  if (call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
    throw new InvalidToolCallError(
      `Tool call "${call.id}" "arguments" must be a plain object.`,
      where,
    );
  }
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeShape(result) {
  const keys = result && typeof result === 'object' ? Object.keys(result).join(', ') : '';
  return keys.length > 0 ? `{${keys}}` : String(result);
}

function safeSummary(call) {
  try {
    return { id: call?.id, name: call?.name };
  } catch {
    return undefined;
  }
}
