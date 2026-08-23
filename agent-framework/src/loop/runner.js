import { ConfigurationError } from '../errors.js';
import { AgentLoop, DEFAULT_MAX_TURNS } from './agent-loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { EventBus } from '../events/bus.js';
import { SequentialStrategy } from '../tools/sequential-strategy.js';

/**
 * Runner — the entire public execution API of Phase 1.
 *
 *   const runner = new Runner({ agent });
 *   const result = await runner.run('hello');
 *
 * Responsibilities: own the shared infrastructure (event bus, registry view,
 * strategy, logger) once per Runner instance and delegate each `run()` to a
 * fresh AgentLoop execution with per-run isolation. Nothing else. Internals
 * (AgentLoop/Turn/ToolExecutor/EventBus wiring) stay behind this class so
 * later phases (persistence, streaming, handoff) extend the Runner without
 * breaking its signature.
 */
export class Runner {
  /**
   * @param {object} options
   * @param {object} options.agent Agent definition (required)
   * @param {number} [options.maxTurns] loop bound override
   * @param {object} [options.strategy] ExecutionStrategy override
   * @param {EventBus} [options.events] pre-built event bus to share across runs
   * @param {object} [options.logger] injectable logger {debug,info,warn,error}
   * @param {ToolRegistry} [options.registry] registry override; else built from agent.tools
   */
  constructor({ agent, maxTurns = DEFAULT_MAX_TURNS, strategy = new SequentialStrategy(), events, logger, registry } = {}) {
    if (!agent) {
      throw new ConfigurationError('Runner requires an "agent".', { field: 'agent' });
    }
    if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new ConfigurationError('"maxTurns" must be an integer >= 1.', { field: 'maxTurns' });
    }
    if (strategy == null || typeof strategy.execute !== 'function') {
      throw new ConfigurationError('"strategy" must implement execute(calls, context).', {
        field: 'strategy',
      });
    }
    if (logger !== undefined && !isLogger(logger)) {
      throw new ConfigurationError('"logger" must expose debug/info/warn/error functions.', {
        field: 'logger',
      });
    }

    this.#agent = agent;
    this.#maxTurns = maxTurns;
    this.#strategy = strategy;
    this.#logger = logger ?? undefined;
    // One bus per Runner unless injected — subscribers observe every run.
    this.#events = events ?? new EventBus({ logger: this.#logger });

    // Registry precedence: explicit > agent-declared tools.
    this.#registry =
      registry ??
      (agent.tools.length > 0
        ? buildDefaultRegistry(agent)
        : new ToolRegistry());
  }

  #agent;
  #maxTurns;
  #strategy;
  #events;
  #registry;
  #logger;

  /** Shared event bus — subscribe here to observe all runs of this Runner. */
  get events() {
    return this.#events;
  }

  /**
   * Execute one isolated run.
   * @param {string|Array|object} input
   * @param {{signal?: AbortSignal, metadata?: object, runId?: string}} [options]
   * @returns {Promise<RunResult>} structured, plain-serializable result
   */
  async run(input, options = {}) {
    const loop = new AgentLoop({
      agent: this.#agent,
      registry: this.#registry,
      strategy: this.#strategy,
      maxTurns: this.#maxTurns,
      events: this.#events,
      logger: this.#logger ?? undefined,
    });
    return loop.run(input, options);
  }
}

function isLogger(logger) {
  return (
    typeof logger.debug === 'function' &&
    typeof logger.info === 'function' &&
    typeof logger.warn === 'function' &&
    typeof logger.error === 'function'
  );
}

function buildDefaultRegistry(agent) {
  const registry = new ToolRegistry();
  for (const tool of agent.tools) {
    registry.register(tool);
  }
  return registry;
}
