import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InvalidStateTransitionError } from '../src/errors.js';
import {
  RunStateEvents as Events,
  RunStateMachine,
  RunStates as States,
} from '../src/state/run-state-machine.js';

describe('RunStateMachine', () => {
  it('follows the final-only lifecycle', () => {
    const machine = new RunStateMachine();

    assert.equal(machine.currentState, States.CREATED);
    assert.equal(machine.isTerminal, false);

    machine.transition(Events.PREPARE);
    machine.transition(Events.REQUEST_MODEL);
    machine.transition(Events.MODEL_RESULT_RECEIVED);
    machine.transition(Events.COMPLETE);

    assert.equal(machine.currentState, States.COMPLETED);
    assert.equal(machine.isTerminal, true);
    assert.deepEqual(machine.history.map(({ from, event, to }) => ({ from, event, to })), [
      { from: States.CREATED, event: Events.PREPARE, to: States.PREPARING },
      { from: States.PREPARING, event: Events.REQUEST_MODEL, to: States.WAITING_FOR_MODEL },
      {
        from: States.WAITING_FOR_MODEL,
        event: Events.MODEL_RESULT_RECEIVED,
        to: States.PROCESSING_MODEL_RESULT,
      },
      { from: States.PROCESSING_MODEL_RESULT, event: Events.COMPLETE, to: States.COMPLETED },
    ]);
  });

  it('follows the tool-cycle lifecycle and returns to model waiting', () => {
    const machine = new RunStateMachine();
    const events = [
      Events.PREPARE,
      Events.REQUEST_MODEL,
      Events.MODEL_RESULT_RECEIVED,
      Events.EXECUTE_TOOLS,
      Events.TOOL_RESULTS_RECEIVED,
      Events.REQUEST_MODEL,
    ];

    for (const event of events) machine.transition(event);

    assert.equal(machine.currentState, States.WAITING_FOR_MODEL);
    assert.deepEqual(machine.history.map((record) => record.sequence), [1, 2, 3, 4, 5, 6]);
  });

  it('allows FAIL from every nonterminal state', () => {
    const paths = [
      [],
      [Events.PREPARE],
      [Events.PREPARE, Events.REQUEST_MODEL],
      [Events.PREPARE, Events.REQUEST_MODEL, Events.MODEL_RESULT_RECEIVED],
      [Events.PREPARE, Events.REQUEST_MODEL, Events.MODEL_RESULT_RECEIVED, Events.EXECUTE_TOOLS],
      [
        Events.PREPARE,
        Events.REQUEST_MODEL,
        Events.MODEL_RESULT_RECEIVED,
        Events.EXECUTE_TOOLS,
        Events.TOOL_RESULTS_RECEIVED,
      ],
    ];

    for (const path of paths) {
      const machine = new RunStateMachine();
      for (const event of path) machine.transition(event);
      machine.transition(Events.FAIL);
      assert.equal(machine.currentState, States.FAILED);
      assert.equal(machine.isTerminal, true);
    }
  });

  it('rejects invalid and unknown events with typed transition context', () => {
    const machine = new RunStateMachine();

    assert.throws(
      () => machine.transition(Events.COMPLETE),
      (error) =>
        error instanceof InvalidStateTransitionError &&
        error.currentState === States.CREATED &&
        error.event === Events.COMPLETE &&
        error.allowedEvents.includes(Events.PREPARE),
    );
    assert.equal(machine.currentState, States.CREATED);
    assert.equal(machine.history.length, 0);

    assert.throws(() => machine.transition('UNKNOWN'), InvalidStateTransitionError);
  });

  it('rejects all transitions from terminal states', () => {
    const completed = new RunStateMachine();
    completed.transition(Events.PREPARE);
    completed.transition(Events.REQUEST_MODEL);
    completed.transition(Events.MODEL_RESULT_RECEIVED);
    completed.transition(Events.COMPLETE);

    const failed = new RunStateMachine();
    failed.transition(Events.FAIL);

    for (const machine of [completed, failed]) {
      for (const event of Object.values(Events)) {
        assert.throws(() => machine.transition(event), InvalidStateTransitionError);
      }
    }
  });

  it('canTransition is side-effect free', () => {
    const machine = new RunStateMachine();

    assert.equal(machine.canTransition(Events.PREPARE), true);
    assert.equal(machine.canTransition(Events.COMPLETE), false);
    assert.equal(machine.currentState, States.CREATED);
    assert.deepEqual(machine.history, []);
  });

  it('produces immutable, serializable plain transition records', () => {
    const machine = new RunStateMachine();
    const context = { runId: 'run_1', turn: { id: 'turn_1', number: 1 } };
    const record = machine.transition(Events.PREPARE, context);

    context.turn.number = 99;
    assert.equal(record.context.turn.number, 1);
    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.context), true);
    assert.equal(Object.isFrozen(record.context.turn), true);
    assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
    assert.throws(() => {
      record.context.turn.number = 2;
    }, TypeError);
    assert.throws(() => machine.history.push(record), TypeError);
  });

  it('isolates state, history, and sequence counters per machine', () => {
    const first = new RunStateMachine();
    const second = new RunStateMachine();

    first.transition(Events.PREPARE, { runId: 'first' });

    assert.equal(first.currentState, States.PREPARING);
    assert.equal(second.currentState, States.CREATED);
    assert.equal(first.history[0].sequence, 1);
    assert.equal(second.history.length, 0);

    const secondRecord = second.transition(Events.FAIL, { runId: 'second' });
    assert.equal(secondRecord.sequence, 1);
    assert.notEqual(first.history, second.history);
  });
});
