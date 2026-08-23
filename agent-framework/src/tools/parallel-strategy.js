import { RunEvents } from '../events/bus.js';
import { ConfigurationError, ToolNotFoundError, ToolResultError, ToolValidationError } from '../errors.js';
import {
  asToolExecutionError,
  emitToolEvent,
  executeSingleCall,
  toolCompletedPayload,
  toolFailedPayload,
  toolStartedPayload,
} from './strategy.js';

/**
 * Default maximum number of tool calls that may execute concurrently within
 * a single batch. Finite, deterministic, and conservative enough to avoid
 * overwhelming external resources by default.
 */
const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * ParallelStrategy — execute a turn's tool calls concurrently up to a bounded
 * limit while preserving deterministic input-order results.
 *
 * Result policy (identical to SequentialStrategy):
 *  - ToolValidationError and ToolExecutionError are per-call recoverable errors;
 *    they produce a status="error" record at the corresponding index and do not
 *    prevent other calls from running.
 *  - ToolNotFoundError is fatal (and is preflighted by ToolExecutor before the
 *    strategy ever sees the batch, so it should not normally arise here).
 *  - ToolResultError (non-serializable output) is fatal and propagates after
 *    in-flight calls settle cleanly.
 *
 * Concurrency semantics:
 *  - At most `maxConcurrency` calls execute at any instant (hard invariant).
 *  - Calls are claimed by workers in original input order.
 *  - Results are stored by original input index and returned in input order,
 *    independent of completion timing.
 *  - One strategy instance carries no cross-run mutable state; each execute()
 *    call owns its own scheduler state (queues, counters, result arrays).
 */
export class ParallelStrategy {
  /**
   * @param {object} [options]
   * @param {number} [options.maxConcurrency=4] maximum simultaneous tool calls
   *   per batch. Must be a positive finite integer >= 1.
   */
  constructor({ maxConcurrency = DEFAULT_MAX_CONCURRENCY } = {}) {
    this.#maxConcurrency = validateMaxConcurrency(maxConcurrency);
  }

  #maxConcurrency;

  /** @returns {number} the configured concurrency limit. */
  get maxConcurrency() {
    return this.#maxConcurrency;
  }

  /**
   * Execute a batch of tool calls with bounded concurrency.
   *
   * @param {Array<{id:string,name:string,arguments:object}>} calls
   * @param {object} context — { registry, runContext, signal, turnId, events }
   * @returns {Promise<Array<object>>} ToolExecution records in input order.
   */
  async execute(calls, context) {
    if (!Array.isArray(calls)) {
      throw new ConfigurationError(
        'ParallelStrategy.execute expects an array of tool calls.',
        { field: 'calls' },
      );
    }
    if (calls.length === 0) return [];

    const {
      registry,
      runContext,
      signal,
      turnId,
      events,
    } = context;

    const maxConcurrency = this.#maxConcurrency;
    const results = new Array(calls.length);
    // All scheduler state lives inside this execute() closure — never on `this`,
    // never at module scope — so concurrent execute() calls / concurrent Runs
    // share no mutable state.
    let nextIndex = 0;
    let fatalError = null;
    let active = 0;
    // Instrumentation hook for tests (non-enumerable, optional): callers
    // (tests) may set context.__observe to receive scheduling events. This
    // uses a non-public key so production callers never depend on it.
    const observe = typeof context?.__observe === 'function' ? context.__observe : () => {};

    const runIdForError = runContext?.runId;

    /**
     * Classify a thrown error as recoverable (return a ToolExecution record)
     * or fatal (re-throw to abort the batch after in-flight work settles).
     * Mirrors SequentialStrategy.#toPerCallError exactly.
     */
    function toPerCallError(cause, call) {
      if (cause instanceof ToolValidationError) return cause;
      if (cause instanceof ToolResultError) return null; // fatal
      if (cause instanceof ToolNotFoundError) return null; // fatal
      return asToolExecutionError(cause, call, { runId: runIdForError, turnId });
    }

    /**
     * Worker loop: claim the next unstarted call synchronously, execute it,
     * store the result at the original index, and repeat until all calls are
     * claimed or a fatal error stops new scheduling.
     */
    async function worker() {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Synchronously claim the next index BEFORE any await so launch
        // ordering is deterministic across workers (single-threaded JS makes
        // this claim atomic).
        if (fatalError) return;
        const index = nextIndex++;
        if (index >= calls.length) return;

        const call = calls[index];

        active += 1;
        observe({ type: 'start', index, active, toolCallId: call.id, toolName: call.name });

        emitToolEvent(
          events,
          RunEvents.TOOL_STARTED,
          { runContext, turnId, call, data: toolStartedPayload(call) },
        );

        let executionResult;
        let terminalEvent;
        let terminalData;
        try {
          const output = await executeSingleCall(call, { registry, runContext, signal, turnId });
          executionResult = {
            toolCallId: call.id,
            toolName: call.name,
            status: 'success',
            output,
            error: null,
          };
          terminalEvent = RunEvents.TOOL_COMPLETED;
          terminalData = toolCompletedPayload(call, output);
        } catch (cause) {
          const perCallErr = toPerCallError(cause, call);
          if (perCallErr) {
            // Recoverable per-call error: record it and continue scheduling.
            executionResult = {
              toolCallId: call.id,
              toolName: call.name,
              status: 'error',
              output: null,
              error: perCallErr,
            };
            terminalEvent = RunEvents.TOOL_FAILED;
            terminalData = toolFailedPayload(call, perCallErr);
          } else {
            // Fatal (ToolNotFoundError / ToolResultError). Record the fatal
            // condition so sibling workers stop claiming new work, emit the
            // terminal event for THIS call, then re-throw so the worker exits.
            // The pool's finally block will decrement active and detect drain.
            executionResult = null;
            terminalEvent = RunEvents.TOOL_FAILED;
            terminalData = toolFailedPayload(call, cause);
            emitToolEvent(events, terminalEvent, { runContext, turnId, call, data: terminalData });
            active -= 1;
            observe({ type: 'fatal', index, active, toolCallId: call.id });
            if (!fatalError) fatalError = cause;
            throw cause;
          }
        }

        // Success or recoverable error: store result at original index,
        // emit the terminal event, then loop to claim more work.
        results[index] = executionResult;
        emitToolEvent(events, terminalEvent, { runContext, turnId, call, data: terminalData });
        active -= 1;
        observe({ type: 'finish', index, active, toolCallId: call.id, status: executionResult.status });
      }
    }

    const workerCount = Math.min(maxConcurrency, calls.length);
    observe({ type: 'pool-start', workers: workerCount, totalCalls: calls.length });

    // Run workers and track settled state. We must catch fatal errors at the
    // worker-pool level so we can wait for ALL already-started workers to
    // finish before propagating the fatal error. Each worker that sees a
    // fatal condition throws; we use Promise.allSettled to observe every
    // worker without letting the first fatal rejection cause sibling workers
    // to become unhandled.
    const workerPromises = [];
    for (let i = 0; i < workerCount; i += 1) {
      workerPromises.push(
        worker().catch((err) => {
          // Capture the first fatal error; subsequent fatals from siblings
          // are swallowed because the first one already set fatalError.
          if (!fatalError) fatalError = err;
        }),
      );
    }

    // Wait for every worker to exit naturally (either when they finish all
    // their claimed calls, or after a fatal when they notice fatalError at
    // their next loop iteration).
    await Promise.all(workerPromises);

    if (fatalError) {
      throw fatalError;
    }

    // Defensive check: every index must have been assigned. If this fires it
    // indicates an internal scheduler bug (should never happen).
    for (let i = 0; i < calls.length; i += 1) {
      if (results[i] === undefined) {
        throw new Error(
          `ParallelStrategy internal invariant violated: no result for call index ${i}`,
        );
      }
    }

    return results;
  }
}

function validateMaxConcurrency(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw new ConfigurationError(
      'ParallelStrategy "maxConcurrency" must be a finite integer.',
      { field: 'maxConcurrency', received: value },
    );
  }
  if (value < 1) {
    throw new ConfigurationError(
      'ParallelStrategy "maxConcurrency" must be >= 1.',
      { field: 'maxConcurrency', received: value },
    );
  }
  return value;
}
