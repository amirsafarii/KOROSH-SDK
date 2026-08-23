import { InvalidStateTransitionError } from '../errors.js';
import { deepCopy, deepFreeze } from '../utils/objects.js';
import { nowMs } from '../utils/time.js';
import {
  RunStateEvents,
  RunStates,
  RunTransitions,
  TerminalRunStates,
} from './run-state.js';

const terminalStates = new Set(TerminalRunStates);

/**
 * Deterministic, per-run lifecycle validator and transition recorder.
 * Execution side effects remain the responsibility of AgentLoop.
 */
export class RunStateMachine {
  constructor() {
    this.#currentState = RunStates.CREATED;
    this.#history = [];
  }

  #currentState;
  #history;

  get currentState() {
    return this.#currentState;
  }

  get history() {
    return Object.freeze([...this.#history]);
  }

  get isTerminal() {
    return terminalStates.has(this.#currentState);
  }

  canTransition(event) {
    return Object.hasOwn(RunTransitions[this.#currentState], event);
  }

  transition(event, context = {}) {
    const transitions = RunTransitions[this.#currentState];
    if (!this.canTransition(event)) {
      throw new InvalidStateTransitionError(
        `Cannot apply event "${String(event)}" while Run is in state "${this.#currentState}".`,
        {
          currentState: this.#currentState,
          event,
          allowedEvents: Object.freeze(Object.keys(transitions)),
        },
      );
    }

    const record = deepFreeze({
      sequence: this.#history.length + 1,
      from: this.#currentState,
      to: transitions[event],
      event,
      timestamp: nowMs(),
      context: deepCopy(context),
    });

    this.#currentState = record.to;
    this.#history.push(record);
    return record;
  }
}

export { RunStateEvents, RunStates } from './run-state.js';
