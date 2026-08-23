import { newRunId } from '../utils/id.js';
import { nowMs } from '../utils/time.js';
import { deepCopy, deepFreeze } from '../utils/objects.js';

/**
 * RunContext — per-run execution identity and ambient data.
 *
 * Strictly separated from persisted conversation state: it identifies which
 * run/agent is executing and carries caller metadata and the normalized input
 * for this run. History accumulated during the loop is owned by AgentLoop.
 */
export class RunContext {
  get runId() {
    return this.#runId;
  }

  get agent() {
    return this.#agent;
  }

  /** Normalized input that started this run. */
  get input() {
    return this.#input;
  }

  /** Caller-supplied correlation data (deep-copied and frozen at construction). */
  get metadata() {
    return this.#metadata;
  }

  /** Wall-clock start of the run (epoch ms). */
  get startedAt() {
    return this.#startedAt;
  }

  /**
   * @param {object} options
   * @param {object} options.agent the Agent definition for this run
   * @param {Array} [options.input] normalized internal input messages
   * @param {string} [options.runId] pre-assigned run id (else generated)
   * @param {object} [options.metadata] caller correlation data
   */
  constructor({ agent, input = [], runId = newRunId(), metadata = {} }) {
    this.#runId = runId;
    this.#agent = agent;
    this.#input = deepFreeze(deepCopy(input));
    this.#metadata = deepFreeze(deepCopy(metadata));
    this.#startedAt = nowMs();
    Object.freeze(this);
  }

  #runId;
  #agent;
  #input;
  #metadata;
  #startedAt;

  /**
   * Read-only projection handed to tools and model adapters — deliberately
   * narrow so future persistence/session layers can extend without breaking
   * consumers.
   */
  describe() {
    return {
      runId: this.#runId,
      agentName: this.#agent?.name ?? null,
      metadata: this.#metadata,
    };
  }
}
