import {
  ConfigurationError,
  InvalidToolCallError,
  ToolNotFoundError,
} from '../errors.js';
import { assertToolExecutionBatch } from './execution-result.js';
import { toToolMessage } from './result.js';
import { SequentialStrategy } from './sequential-strategy.js';
import { RunEvents } from '../events/bus.js';
import { emitToolEvent, toolFailedPayload, toolStartedPayload } from './strategy.js';

/**
 * ToolExecutor — the loop-facing facade over the tool pipeline:
 *
 *   Validate Call Shape → Resolve Tool → Execute → Normalize
 *
 * Produces, for every model tool_call, BOTH artifacts downstream needs:
 *   - ToolExecution  {toolCallId,toolName,status,output,error}  (bookkeeping)
 *   - internal message {role:'tool', toolCallId, content}       (next model input)
 *
 * A missing tool is treated as fatal configuration/model-call error and is not
 * swallowed. Validation and execution failures are represented as per-call
 * error results, allowing the model to receive and recover from them.
 */
export class ToolExecutor {
  /**
   * @param {object} options
   * @param {import('./registry.js').ToolRegistry} options.registry
   * @param {object} [options.strategy] ExecutionStrategy (default Sequential)
   */
  constructor({ registry, strategy } = {}) {
    assertRegistry(registry);
    const resolvedStrategy = strategy ?? new SequentialStrategy();
    assertStrategy(resolvedStrategy);

    this.#registry = registry;
    this.#strategy = resolvedStrategy;
  }

  #registry;
  #strategy;

  get registry() {
    return this.#registry;
  }

  /**
   * Execute every call through the configured strategy and normalize outcomes.
   *
   * @param {Array<{id,name,arguments}>} calls
   * @param {object} env
   * @returns {Promise<{executions:Array, messages:Array<{role:'tool',toolCallId,content}>}>}
   */
  async executeCalls(calls, env) {
    if (!Array.isArray(calls) || calls.length === 0) {
      return { executions: [], messages: [] };
    }

    assertToolCalls(calls);
    assertExecutionEnvironment(env);

    this.#assertToolsRegistered(calls, env);

    const executions = await this.#strategy.execute(calls, {
      registry: this.#registry,
      runContext: env.runContext,
      signal: env.signal,
      turnId: env.turnId,
      events: env.events,
    });
    assertToolExecutionBatch(calls, executions);

    const messages = executions.map((execution) =>
      toToolMessage({
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        status: execution.status,
        output: execution.output,
        error: execution.error,
      }),
    );

    return { executions, messages };
  }

  #assertToolsRegistered(calls, env) {
    for (const call of calls) {
      if (this.#registry.has(call.name)) continue;

      const error = new ToolNotFoundError(`Tool "${call.name}" is not registered.`, {
        runId: env.runContext.runId,
        turnId: env.turnId,
        toolCallId: call.id,
        toolName: call.name,
      });

      emitToolEvent(
        env.events,
        RunEvents.TOOL_STARTED,
        { ...env, call, data: toolStartedPayload(call) },
      );
      emitToolEvent(
        env.events,
        RunEvents.TOOL_FAILED,
        { ...env, call, data: toolFailedPayload(call, error) },
      );
      throw error;
    }
  }
}

function assertRegistry(registry) {
  if (
    registry === null ||
    typeof registry !== 'object' ||
    typeof registry.get !== 'function' ||
    typeof registry.has !== 'function' ||
    typeof registry.list !== 'function'
  ) {
    throw new ConfigurationError(
      'ToolExecutor requires a registry exposing get(), has(), and list().',
      { field: 'registry' },
    );
  }
}

function assertStrategy(strategy) {
  if (strategy == null || typeof strategy.execute !== 'function') {
    throw new ConfigurationError('ToolExecutor strategy must implement execute(calls, context).', {
      field: 'strategy',
    });
  }
}

function assertExecutionEnvironment(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new ConfigurationError('ToolExecutor.executeCalls requires an execution environment.', {
      field: 'env',
    });
  }
  if (
    env.runContext === null ||
    typeof env.runContext !== 'object' ||
    typeof env.runContext.runId !== 'string' ||
    typeof env.runContext.describe !== 'function'
  ) {
    throw new ConfigurationError(
      'ToolExecutor execution environment requires a RunContext with runId and describe().',
      { field: 'env.runContext' },
    );
  }
  if (env.events != null && typeof env.events.emit !== 'function') {
    throw new ConfigurationError('ToolExecutor execution environment events must expose emit().', {
      field: 'env.events' },
    );
  }
}

function assertToolCalls(calls) {
  const seenIds = new Map();
  for (const [index, call] of calls.entries()) {
    assertToolCallShape(call, index);
    if (seenIds.has(call.id)) {
      throw new InvalidToolCallError(`Tool call id "${call.id}" is duplicated in one batch.`, {
        toolCallId: call.id,
        toolCallIndex: index,
        firstToolCallIndex: seenIds.get(call.id),
      });
    }
    seenIds.set(call.id, index);
  }
}

function assertToolCallShape(call, index) {
  if (call === null || typeof call !== 'object' || Array.isArray(call)) {
    throw new InvalidToolCallError(`Tool call at index ${index} must be an object.`, {
      toolCallIndex: index,
    });
  }
  if (typeof call.id !== 'string' || call.id.length === 0) {
    throw new InvalidToolCallError(`Tool call at index ${index} requires non-empty string "id".`, {
      toolCallIndex: index,
    });
  }
  if (typeof call.name !== 'string' || call.name.length === 0) {
    throw new InvalidToolCallError(`Tool call "${call.id}" requires non-empty string "name".`, {
      toolCallId: call.id,
      toolCallIndex: index,
    });
  }
  if (call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
    throw new InvalidToolCallError(
      `Tool call "${call.id}" requires an "arguments" object.`,
      { toolCallId: call.id, toolName: call.name, toolCallIndex: index },
    );
  }
}
