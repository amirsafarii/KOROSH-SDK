import { RunEvents } from '../events/bus.js';
import { ToolNotFoundError, ToolResultError, ToolValidationError } from '../errors.js';
import {
  asToolExecutionError,
  emitToolEvent,
  executeSingleCall,
  toolCompletedPayload,
  toolFailedPayload,
  toolStartedPayload,
} from './strategy.js';

/**
 * SequentialStrategy — Phase 1 default: run each tool call one after another
 * in model-requested order. Implements the ExecutionStrategy contract; the
 * loop never hard-codes this choice.
 *
 * Result policy:
 *  - argument validation and tool execution errors are per-call error results;
 *  - missing tools and non-serializable results are fatal and propagate.
 */
export class SequentialStrategy {
  /**
   * @param {Array<{id,name,arguments}>} calls
   * @param {object} context
   * @returns {Promise<Array<object>>}
   */
  async execute(calls, context) {
    const results = [];

    for (const call of calls) {
      emitToolEvent(
        context.events,
        RunEvents.TOOL_STARTED,
        { ...context, call, data: toolStartedPayload(call) },
      );

      try {
        const output = await executeSingleCall(call, context);
        const result = {
          toolCallId: call.id,
          toolName: call.name,
          status: 'success',
          output,
          error: null,
        };
        emitToolEvent(
          context.events,
          RunEvents.TOOL_COMPLETED,
          { ...context, call, data: toolCompletedPayload(call, output) },
        );
        results.push(result);
      } catch (cause) {
        const error = this.#toPerCallError(cause, call, context);
        if (error) {
          results.push({
            toolCallId: call.id,
            toolName: call.name,
            status: 'error',
            output: null,
            error,
          });
          emitToolEvent(
            context.events,
            RunEvents.TOOL_FAILED,
            { ...context, call, data: toolFailedPayload(call, error) },
          );
          continue;
        }

        emitToolEvent(
          context.events,
          RunEvents.TOOL_FAILED,
          { ...context, call, data: toolFailedPayload(call, cause) },
        );
        throw cause;
      }
    }

    return results;
  }

  #toPerCallError(cause, call, context) {
    if (cause instanceof ToolValidationError) return cause;
    if (cause instanceof ToolResultError) return null;
    if (cause instanceof ToolNotFoundError) return null;
    return asToolExecutionError(cause, call, {
      runId: context.runContext.runId,
      turnId: context.turnId,
    });
  }
}
