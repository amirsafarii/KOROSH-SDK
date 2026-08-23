import { ToolRegistry } from '../tools/registry.js';
import {
  InputError,
  LoopError,
  MaxTurnsError,
  ModelError,
} from '../errors.js';
import { assertModelResult, cloneNormalizedResult } from '../model/types.js';
import { normalizeInput } from '../input/normalizer.js';
import { ToolExecutor } from '../tools/executor.js';
import { RunContext } from '../context/run-context.js';
import { EventBus, RunEvents } from '../events/bus.js';
import { deepCopy } from '../utils/objects.js';
import { nowMs } from '../utils/time.js';
import { toPlainError } from '../utils/serialization.js';
import { RunStateEvents, RunStateMachine } from '../state/run-state-machine.js';
import { Turn } from './turn.js';

export const DEFAULT_MAX_TURNS = 10;

/**
 * AgentLoop — the deterministic execution engine.
 *
 * Implements exactly one cycle shape:
 *   User Input → Prepare Run → Prepare Turn → Model Call → Analyze Result
 *     → Final → Finish
 *     or → Tool Calls → Validate/Resolve/Execute/Normalize → Append Results
 *          → next Model Call
 *
 * Isolation: every `run()` call builds its own conversation copy, its own
 * RunContext and its own execution data. Concurrent runs share no mutable run
 * state. The loop is provider-agnostic: it only knows NormalizedModelResult.
 */
export class AgentLoop {
  /**
   * @param {object} options
   * @param {import('../core/agent.js').Agent} options.agent validated definition
   * @param {import('../tools/registry.js').ToolRegistry} [options.registry]
   *        defaults to a registry built from agent.tools
   * @param {object} [options.strategy] ExecutionStrategy override (tests / future ParallelStrategy)
   * @param {number} [options.maxTurns=DEFAULT_MAX_TURNS] hard loop bound
   * @param {EventBus} [options.events] shared bus (Runner injects one)
   * @param {object} [options.logger] injectable {debug,info,warn,error}
   */
  constructor({ agent, registry, strategy, maxTurns = DEFAULT_MAX_TURNS, events, logger }) {
    if (!agent) {
      throw new LoopError('AgentLoop requires an agent.');
    }
    const resolvedRegistry = registry ?? buildRegistryFromAgent(agent);
    this.#executor = new ToolExecutor({ registry: resolvedRegistry, strategy });
    this.#agent = agent;
    this.#maxTurns = validateMaxTurns(maxTurns);
    this.#events = events ?? new EventBus({ logger });
  }

  #agent;
  #executor;
  #maxTurns;
  #events;

  /** @returns {EventBus} the bus this loop emits lifecycle events on */
  get events() {
    return this.#events;
  }

  get maxTurns() {
    return this.#maxTurns;
  }

  /**
   * Execute one complete run.
   * @param {string|Array|object} input public run input (normalized internally)
   * @param {{signal?: AbortSignal, metadata?: object, runId?: string}} [options]
   * @returns {Promise<RunResult>}
   */
  async run(input, options = {}) {
    const signal = options.signal ?? null;
    let history;
    try {
      history = normalizeInput(input);
    } catch (cause) {
      throw enrich(cause, { runId: options.runId });
    }

    const runContext = new RunContext({
      agent: this.#agent,
      input: history,
      runId: options.runId,
      metadata: options.metadata,
    });
    const runId = runContext.runId;
    const startedAt = runContext.startedAt;
    const stateMachine = new RunStateMachine();

    this.#events.emit(RunEvents.RUN_STARTED, {
      runId,
      data: { agent: this.#agent.describe(), metadata: runContext.metadata },
    });

    const turns = [];
    try {
      this.#transitionState(stateMachine, RunStateEvents.PREPARE, { runId });

      for (let turnNumber = 1; turnNumber <= this.#maxTurns; turnNumber++) {
        const turn = new Turn({ number: turnNumber, input: deepCopy(history) });
        turns.push(turn);
        this.#events.emit(RunEvents.TURN_STARTED, {
          runId,
          turnId: turn.id,
          data: { number: turn.number },
        });
        this.#transitionState(stateMachine, RunStateEvents.REQUEST_MODEL, { runId, turn });

        this.#events.emit(RunEvents.MODEL_STARTED, {
          runId,
          turnId: turn.id,
          data: { number: turn.number },
        });

        let modelResult;
        try {
          modelResult = await this.callModel({
            instructions: this.#agent.instructions,
            input: deepCopy(history),
            tools: this.#executor.registry.list().map((tool) => tool.describe()),
            metadata: {
              ...runContext.metadata,
              runId,
              turnNumber: turn.number,
              agentName: this.#agent.name,
              modelId: modelId(this.#agent.model),
            },
            signal,
          });
        } catch (cause) {
          throw enrich(
            cause instanceof ModelError
              ? cause
              : new ModelError('Model adapter failed.', { cause }),
            { runId, turnId: turn.id },
          );
        }

        this.#transitionState(stateMachine, RunStateEvents.MODEL_RESULT_RECEIVED, {
          runId,
          turn,
        });
        assertModelResult(modelResult, { runId, turnId: turn.id });
        // Normalize only Core-owned fields. Provider-specific usage/metadata
        // are passed through by reference without coupling Core to them.
        modelResult = cloneNormalizedResult(modelResult);
        turn.setModelResult(modelResult);
        this.#events.emit(RunEvents.MODEL_COMPLETED, {
          runId,
          turnId: turn.id,
          data: {
            number: turn.number,
            hasFinal: typeof modelResult.final === 'string',
            toolCallCount: turn.toolCalls.length,
          },
        });

        if (typeof modelResult.final === 'string' && turn.toolCalls.length === 0) {
          turn.complete();
          this.#events.emit(RunEvents.TURN_COMPLETED, {
            runId,
            turnId: turn.id,
            data: { number: turn.number, status: turn.status },
          });
          this.#transitionState(stateMachine, RunStateEvents.COMPLETE, { runId, turn });
          const result = buildRunResult({
            runContext,
            stateMachine,
            status: 'completed',
            output: modelResult.final,
            turns,
            startedAt,
          });
          this.#emitRunCompleted(runId, result);
          return result;
        }

        if (turnNumber < this.#maxTurns && turn.toolCalls.length > 0) {
          this.#transitionState(stateMachine, RunStateEvents.EXECUTE_TOOLS, { runId, turn });
          const { executions, messages } = await this.#executor.executeCalls(turn.toolCalls, {
            runContext,
            signal,
            turnId: turn.id,
            events: this.#events,
          });
          this.#transitionState(stateMachine, RunStateEvents.TOOL_RESULTS_RECEIVED, {
            runId,
            turn,
          });
          turn.setToolResults(executions);
          history.push(...messages);
          turn.complete();
          this.#events.emit(RunEvents.TURN_COMPLETED, {
            runId,
            turnId: turn.id,
            data: {
              number: turn.number,
              status: turn.status,
              toolResults: summarizeToolResults(executions),
            },
          });
          continue;
        }

        if (turn.toolCalls.length === 0) {
          throw new LoopError('Model produced neither final output nor tool calls.', {
            runId,
            turnId: turn.id,
          });
        }
        break;
      }

      throw new MaxTurnsError(
        `Run exceeded maxTurns (${this.#maxTurns}) without producing final output.`,
        { runId, maxTurns: this.#maxTurns },
      );
    } catch (cause) {
      const failure = enrich(cause, { runId });
      const interruptedTurn = markFailedTurn(turns, failure);
      if (interruptedTurn) {
        this.#events.emit(RunEvents.TURN_COMPLETED, {
          runId,
          turnId: interruptedTurn.id,
          data: { number: interruptedTurn.number, status: interruptedTurn.status },
        });
      }
      this.#transitionState(stateMachine, RunStateEvents.FAIL, {
        runId,
        turn: interruptedTurn ?? turns.at(-1) ?? null,
      });
      const result = buildRunResult({
        runContext,
        stateMachine,
        status: 'failed',
        error: failure,
        turns,
        startedAt,
      });
      this.#events.emit(RunEvents.RUN_FAILED, {
        runId,
        data: { error: toPlainError(failure), lastTurnNumber: turns.length },
      });
      return result;
    }
  }

  #transitionState(stateMachine, event, { runId, turn = null }) {
    const record = stateMachine.transition(event, {
      runId,
      turnId: turn?.id ?? null,
      turnNumber: turn?.number ?? null,
    });
    this.#events.emit(RunEvents.RUN_STATE_CHANGED, {
      runId,
      turnId: turn?.id ?? null,
      data: record,
    });
    return record;
  }

  #emitRunCompleted(runId, result) {
    this.#events.emit(RunEvents.RUN_COMPLETED, {
      runId,
      data: {
        output: result.output,
        turnCount: result.turns.length,
        durationMs: result.metadata.durationMs,
      },
    });
  }

  /**
   * Model seam — isolated so later phases can decorate it (retry, tracing,
   * streaming) without touching cycle logic. The request is a defensive
   * copy: adapters cannot mutate this run's conversation state.
   * @returns {Promise<NormalizedModelResult>}
   */
  async callModel(request) {
    try {
      return await this.#agent.model.call(request, { signal: request.signal ?? null });
    } catch (cause) {
      if (cause instanceof ModelError) {
        throw cause;
      }
      throw new ModelError(`Model call failed in turn ${request.metadata.turnNumber}.`, {
        runId: request.metadata.runId,
        cause,
      });
    }
  }
}

function buildRegistryFromAgent(agent) {
  const registry = new ToolRegistry();
  for (const tool of agent.tools) {
    registry.register(tool);
  }
  return registry;
}

function validateMaxTurns(maxTurns) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new InputError('"maxTurns" must be an integer >= 1.', { received: maxTurns });
  }
  return maxTurns;
}

function enrich(error, { runId, turnId } = {}) {
  if (error === null || typeof error !== 'object') {
    return new LoopError(String(error), { runId, turnId });
  }
  if (!('runId' in error) && runId !== undefined) {
    Object.defineProperty(error, 'runId', {
      value: runId,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (turnId !== undefined && !('turnId' in error)) {
    Object.defineProperty(error, 'turnId', {
      value: turnId,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

function markFailedTurn(turns, error) {
  const runningTurn = [...turns].reverse().find((t) => t.status === Turn.Status.RUNNING);
  if (runningTurn) {
    runningTurn.fail(error);
    return runningTurn;
  }
  return null;
}

function buildRunResult({
  runContext,
  stateMachine,
  status,
  output = null,
  error = null,
  turns,
  startedAt,
}) {
  const endedAt = nowMs();
  return {
    runId: runContext.runId,
    status,
    state: stateMachine.currentState,
    stateTransitions: stateMachine.history,
    output,
    ...(error ? { error: toPlainError(error) } : {}),
    turns: turns.map((t) => t.snapshot()),
    lastTurn: turns.length > 0 ? turns[turns.length - 1].snapshot() : null,
    metadata: {
      ...runContext.metadata,
      agentName: runContext.agent.name,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
    },
  };
}

function summarizeToolResults(executions) {
  return executions.map((execution) => ({
    toolCallId: execution.toolCallId,
    toolName: execution.toolName,
    status: execution.status,
  }));
}

function modelId(model) {
  return typeof model?.id === 'string' && model.id.length > 0 ? model.id : 'anonymous-model';
}
