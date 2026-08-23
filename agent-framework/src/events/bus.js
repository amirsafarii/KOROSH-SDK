import { newEventId } from '../utils/id.js';
import { timestamp } from '../utils/time.js';

/**
 * Event types emitted by the loop. The set is deliberately closed for
 * Phase 1 — lifecycle-consistent ordering is a tested guarantee.
 */
export const RunEvents = Object.freeze({
  RUN_STARTED: 'run.started',
  RUN_STATE_CHANGED: 'run.state.changed',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  TURN_STARTED: 'turn.started',
  TURN_COMPLETED: 'turn.completed',
  MODEL_STARTED: 'model.started',
  MODEL_COMPLETED: 'model.completed',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',
});

/**
 * EventBus — synchronous, ordered, injectable event fan-out.
 *
 * Events are plain serializable objects:
 *   { id, type, timestamp, runId, turnId|null, data }
 *
 * Subscriber errors never break the run: they are routed to the injected
 * logger (an event pipeline failure must not corrupt agent execution), and
 * the offending subscriber can be removed by the host if desired.
 */
export class EventBus {
  /** @param {object} [options] */
  constructor({ logger = nullLogger } = {}) {
    this.#subscribers = [];
    this.#logger = logger;
  }

  #subscribers;
  #logger;

  /**
   * Subscribe to events. Returns an unsubscribe function.
   * @param {(event) => void} handler
   * @returns {() => void}
   */
  on(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('EventBus.on expects a function.');
    }
    this.#subscribers.push(handler);
    return () => this.off(handler);
  }

  off(handler) {
    const index = this.#subscribers.indexOf(handler);
    if (index >= 0) {
      this.#subscribers.splice(index, 1);
    }
  }

  /**
   * Build and dispatch one event synchronously in subscription order.
   * @param {string} type one of RunEvents
   * @param {object} envelope { runId, turnId?, data }
   */
  emit(type, { runId, turnId = null, data = {} }) {
    const event = {
      id: newEventId(),
      type,
      timestamp: timestamp(),
      runId,
      turnId,
      data,
    };
    for (const handler of [...this.#subscribers]) {
      try {
        handler(event);
      } catch (error) {
        this.#logger.error('event subscriber threw', { eventType: type, error });
      }
    }
    return event;
  }
}

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };
