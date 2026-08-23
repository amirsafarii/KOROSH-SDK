import { newTurnId } from '../utils/id.js';
import { nowMs } from '../utils/time.js';
import { toTurnError } from '../utils/serialization.js';

/**
 * Turn — one model-call cycle inside a run.
 *
 * Lifecycle: created (running) → completed | failed.
 * Fields are filled progressively by the loop; `snapshot()` yields a plain
 * serializable record suitable for events, results and future persistence.
 */
export class Turn {
  static Status = Object.freeze({
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
  });

  /**
   * @param {object} params
   * @param {number} params.number 1-based turn ordinal within the run
   * @param {Array<{role,content,toolCallId?}>} params.input internal messages fed to the model this turn
   */
  constructor({ number, input }) {
    this.id = newTurnId();
    this.number = number;
    this.startedAt = nowMs();
    this.endedAt = null;
    this.input = input; // already an isolated copy owned by this run
    this.modelResult = null;
    this.toolCalls = [];
    this.toolResults = [];
    this.status = Turn.Status.RUNNING;
    this.error = null;
  }

  /** Record the normalized adapter response for this turn. */
  setModelResult(result) {
    this.modelResult = result;
    this.toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  }

  /** Attach executor output and close the tool phase of the turn. */
  setToolResults(executions) {
    this.toolResults = executions.map((execution) => {
      const record = {
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        status: execution.status,
      };
      if (execution.status === 'success') {
        record.output = execution.output;
      } else {
        record.error = toTurnError(execution.error);
      }
      return record;
    });
  }

  complete() {
    if (this.status !== Turn.Status.RUNNING) {
      throw new Error(`Turn ${this.id} is not running.`);
    }
    this.status = Turn.Status.COMPLETED;
    this.endedAt = nowMs();
  }

  fail(error) {
    if (this.status !== Turn.Status.RUNNING) {
      throw new Error(`Turn ${this.id} is not running.`);
    }
    this.status = Turn.Status.FAILED;
    this.endedAt = nowMs();
    this.error = toTurnError(error);
  }

  /** Plain serializable projection (safe for events/results/persistence). */
  snapshot() {
    return {
      id: this.id,
      number: this.number,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      input: this.input,
      modelResult: this.modelResult ?? null,
      toolCalls: this.toolCalls,
      toolResults: this.toolResults,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
    };
  }
}
