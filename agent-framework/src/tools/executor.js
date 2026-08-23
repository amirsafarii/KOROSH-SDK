import { InvalidToolCallError, ToolNotFoundError } from '../errors.js';
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
  constructor({ registry, strategy }) {
    this.#registry = registry;
    this.#strategy = strategy ?? new SequentialStrategy();
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

    for (const [index, call] of calls.entries()) {
      assertToolCallShape(call, index);
    }

    this.#assertToolsRegistered(calls, env);

    const executions = await this.#strategy.execute(calls, {
      registry: this.#registry,
      runContext: env.runContext,
      signal: env.signal,
      turnId: env.turnId,
      events: env.events,
    });

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
