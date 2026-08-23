/**
 * ExecutionStrategy — HOW a turn's tool calls run, decided outside the loop.
 *
 * Phase 1 ships SequentialStrategy only; ParallelStrategy can be added later
 * without touching AgentLoop because the loop depends solely on this
 * contract:
 *
 *   async execute(calls, context) => ToolExecution[]
 *
 *   calls:    [{id, name, arguments}]  (validated model tool_calls)
 *   context:  {
 *               signal, registry, runContext, turnId?,
 *               events?: EventBus, logger?: object
 *             }
 *   returns:  array of standard ToolExecution records, one per input call,
 *             in the same order as `calls`.
 */
import {
  FrameworkError,
  ToolExecutionError,
  ToolNotFoundError,
  ToolResultError,
  ToolValidationError,
} from '../errors.js';
import { plainCopy, toPlainError } from '../utils/serialization.js';
import { normalizeToolOutput } from './result.js';

/** Shared per-call machinery: lookup → validate → execute. Strategy orders the calls. */
export async function executeSingleCall(call, { registry, runContext, signal, turnId }) {
  const context = {
    runId: runContext.runId,
    turnId,
    toolCallId: call.id,
    toolName: call.name,
  };

  const tool = registry.get(call.name);
  if (tool === undefined) {
    throw new ToolNotFoundError(`Tool "${call.name}" is not registered.`, context);
  }

  const validation = validateArguments(call.arguments, tool.parameters);
  if (!validation.valid) {
    throw new ToolValidationError(
      `Tool "${call.name}" received invalid arguments: ${validation.message}`,
      context,
    );
  }

  let rawOutput;
  try {
    rawOutput = tool.execute(deepCopyArgs(call.arguments), runContext.describe(), { signal });
    rawOutput = await Promise.resolve(rawOutput);
  } catch (cause) {
    throw new ToolExecutionError(
      `Tool "${call.name}" failed: ${cause?.message ?? String(cause)}`,
      { ...context, cause },
    );
  }

  try {
    return normalizeToolOutput(rawOutput, {
      toolCallId: call.id,
      toolName: call.name,
    });
  } catch (cause) {
    if (cause instanceof ToolResultError) {
      for (const [key, value] of Object.entries(context)) {
        if (!(key in cause)) cause[key] = value;
      }
      throw cause;
    }
    throw new ToolResultError(`Tool "${call.name}" returned a non-serializable result.`, {
      ...context,
      cause,
    });
  }
}

/** Emit one tool lifecycle event when an EventBus has been injected. */
export function emitToolEvent(events, type, { runContext, turnId, call, data = {} }) {
  if (!events) return;
  events.emit(type, {
    runId: runContext.runId,
    turnId: turnId ?? null,
    data: {
      toolCallId: call.id,
      toolName: call.name,
      ...data,
    },
  });
}

/** Convert a thrown value into a typed tool pipeline error. */
export function asToolExecutionError(cause, call, { runId, turnId }) {
  if (cause instanceof FrameworkError) return cause;
  return new ToolExecutionError(
    `Tool "${call.name}" failed: ${cause?.message ?? String(cause)}`,
    {
      runId,
      turnId,
      toolCallId: call.id,
      toolName: call.name,
      cause,
    },
  );
}

/** Event payload helper — event data must stay plain/serializable. */
export function toolEventPayload(call, extra = {}) {
  return {
    toolCallId: call.id,
    toolName: call.name,
    ...extra,
  };
}

export function toolStartedPayload(call) {
  return toolEventPayload(call, { arguments: plainCopy(call.arguments) });
}

export function toolCompletedPayload(call, output) {
  return toolEventPayload(call, { status: 'success', output: plainCopy(output) });
}

export function toolFailedPayload(call, error) {
  return toolEventPayload(call, { status: 'error', error: toPlainError(error) });
}

/**
 * Minimal structural validation against the tool's schema object. Supports
 * `type`, `required` and `properties.<key>.type` — deliberately tiny: richer
 * validation belongs to user-supplied schemas/tools (Phase 13 guardrails),
 * not to Core.
 */
export function validateArguments(args, parameters) {
  if (!isPlainObject(parameters)) {
    return { valid: true };
  }
  if ((parameters.type ?? 'object') !== 'object') {
    return { valid: true }; // non-object schemas are out of Core's scope
  }
  if (!isPlainObject(args)) {
    return { valid: false, message: 'arguments must be an object' };
  }

  for (const key of Array.isArray(parameters.required) ? parameters.required : []) {
    if (!(key in args)) {
      return { valid: false, message: `missing required argument "${key}"` };
    }
  }

  const properties = isPlainObject(parameters.properties) ? parameters.properties : {};
  for (const [key, spec] of Object.entries(properties)) {
    if (!(key in args) || !isPlainObject(spec)) continue;
    const actual = args[key];
    const expected = typeof spec.type === 'string' ? spec.type : null;
    if (expected && !matchesType(actual, expected)) {
      return {
        valid: false,
        message: `argument "${key}" must be ${expected}`,
      };
    }
  }
  return { valid: true };
}

function matchesType(value, expected) {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true; // unknown type keywords never reject
  }
}

function deepCopyArgs(args) {
  return structuredClone(args);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
