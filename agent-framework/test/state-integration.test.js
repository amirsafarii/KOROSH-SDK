import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Runner } from '../src/loop/runner.js';
import { RunEvents } from '../src/events/bus.js';
import { RunStateEvents as StateEvents, RunStates } from '../src/state/run-state-machine.js';
import { MockModel } from './helpers/mock-model.js';
import { makeAgent, makeTool } from './helpers/fixtures.js';

function transitionPath(result) {
  return result.stateTransitions.map(({ from, event, to }) => ({ from, event, to }));
}

describe('Run State Machine integration', () => {
  it('records the final-only success lifecycle without changing Phase 1 semantics', async () => {
    const runner = new Runner({
      agent: makeAgent({ model: new MockModel({ script: ['done'] }) }),
    });

    const result = await runner.run('go');

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'done');
    assert.equal(result.turns.length, 1);
    assert.equal(result.lastTurn.status, 'completed');
    assert.equal(result.state, RunStates.COMPLETED);
    assert.deepEqual(transitionPath(result), [
      { from: RunStates.CREATED, event: StateEvents.PREPARE, to: RunStates.PREPARING },
      {
        from: RunStates.PREPARING,
        event: StateEvents.REQUEST_MODEL,
        to: RunStates.WAITING_FOR_MODEL,
      },
      {
        from: RunStates.WAITING_FOR_MODEL,
        event: StateEvents.MODEL_RESULT_RECEIVED,
        to: RunStates.PROCESSING_MODEL_RESULT,
      },
      {
        from: RunStates.PROCESSING_MODEL_RESULT,
        event: StateEvents.COMPLETE,
        to: RunStates.COMPLETED,
      },
    ]);
  });

  it('records a tool-to-final lifecycle while preserving tool behavior', async () => {
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 'echo', { text: 'ping' })),
        'echo:ping',
      ],
    });
    const echo = makeTool('echo', ({ text }) => text, {
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    });
    const result = await new Runner({ agent: makeAgent({ model, tools: [echo] }) }).run('go');

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'echo:ping');
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].toolResults[0].output, 'ping');
    assert.deepEqual(result.stateTransitions.map((record) => record.to), [
      RunStates.PREPARING,
      RunStates.WAITING_FOR_MODEL,
      RunStates.PROCESSING_MODEL_RESULT,
      RunStates.EXECUTING_TOOLS,
      RunStates.PROCESSING_TOOL_RESULTS,
      RunStates.WAITING_FOR_MODEL,
      RunStates.PROCESSING_MODEL_RESULT,
      RunStates.COMPLETED,
    ]);
  });

  it('transitions failures to FAILED without replacing the original error', async () => {
    const providerError = new Error('provider unavailable');
    const model = {
      id: 'failing-model',
      async call() {
        throw providerError;
      },
    };
    const runner = new Runner({ agent: makeAgent({ model }) });

    const result = await runner.run('go');

    assert.equal(result.status, 'failed');
    assert.equal(result.state, RunStates.FAILED);
    assert.equal(result.error.name, 'ModelError');
    assert.match(result.error.message, /Model call failed/);
    assert.equal(result.error.cause.message, providerError.message);
    assert.equal(result.lastTurn.status, 'failed');
    assert.deepEqual(result.stateTransitions.map((record) => record.event), [
      StateEvents.PREPARE,
      StateEvents.REQUEST_MODEL,
      StateEvents.FAIL,
    ]);
  });

  it('emits additive state events in deterministic order without reordering existing events', async () => {
    const model = new MockModel({
      script: [MockModel.toolCalls(MockModel.toolCall('c1', 't', {})), 'done'],
    });
    const runner = new Runner({
      agent: makeAgent({ model, tools: [makeTool('t', () => 'ok')] }),
    });
    const seen = [];
    runner.events.on((event) => seen.push(event));

    const result = await runner.run('go');

    assert.deepEqual(seen.map((event) => event.type), [
      RunEvents.RUN_STARTED,
      RunEvents.RUN_STATE_CHANGED,
      RunEvents.TURN_STARTED,
      RunEvents.RUN_STATE_CHANGED,
      RunEvents.MODEL_STARTED,
      RunEvents.RUN_STATE_CHANGED,
      RunEvents.MODEL_COMPLETED,
      RunEvents.RUN_STATE_CHANGED,
      RunEvents.TOOL_STARTED,
      RunEvents.TOOL_COMPLETED,
      RunEvents.RUN_STATE_CHANGED,
      RunEvents.TURN_COMPLETED,
      RunEvents.TURN_STARTED,
      RunEvents.RUN_STATE_CHANGED,
      RunEvents.MODEL_STARTED,
      RunEvents.RUN_STATE_CHANGED,
      RunEvents.MODEL_COMPLETED,
      RunEvents.TURN_COMPLETED,
      RunEvents.RUN_STATE_CHANGED,
      RunEvents.RUN_COMPLETED,
    ]);

    const toolEvents = seen.filter((event) => event.type.startsWith('tool.'));
    assert.deepEqual(toolEvents.map((event) => event.type), [
      RunEvents.TOOL_STARTED,
      RunEvents.TOOL_COMPLETED,
    ]);
    assert.deepEqual(toolEvents.map((event) => event.data), [
      { toolCallId: 'c1', toolName: 't', arguments: {} },
      { toolCallId: 'c1', toolName: 't', status: 'success', output: 'ok' },
    ]);

    const stateEvents = seen.filter((event) => event.type === RunEvents.RUN_STATE_CHANGED);
    assert.deepEqual(stateEvents.map((event) => event.data), result.stateTransitions);
    assert.deepEqual(stateEvents.map((event) => event.data.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const event of stateEvents) {
      assert.equal(event.runId, result.runId);
      assert.equal(event.turnId, event.data.context.turnId);
    }
  });

  it('keeps RunResult and transition data JSON-serializable', async () => {
    const model = new MockModel({
      script: [MockModel.toolCalls(MockModel.toolCall('c1', 'object', {})), 'done'],
    });
    const runner = new Runner({
      agent: makeAgent({ model, tools: [makeTool('object', () => ({ ok: true }))] }),
    });

    const result = await runner.run('go', { metadata: { correlationId: 'corr-1' } });

    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(result.stateTransitions.every((record) => Object.isFrozen(record)), true);
  });

  it('isolates state machines and transition histories across concurrent runs', async () => {
    const model = {
      id: 'concurrent-model',
      async call(request) {
        await Promise.resolve();
        const input = request.input.find((message) => message.role === 'user').content;
        return { final: `answer:${input}`, toolCalls: [] };
      },
    };
    const runner = new Runner({ agent: makeAgent({ model }) });

    const [first, second] = await Promise.all([
      runner.run('first'),
      runner.run('second'),
    ]);

    assert.notEqual(first.runId, second.runId);
    assert.equal(first.output, 'answer:first');
    assert.equal(second.output, 'answer:second');
    assert.notEqual(first.stateTransitions, second.stateTransitions);
    assert.deepEqual(first.stateTransitions.map((record) => record.sequence), [1, 2, 3, 4]);
    assert.deepEqual(second.stateTransitions.map((record) => record.sequence), [1, 2, 3, 4]);
    assert.equal(
      first.stateTransitions.every((record) => record.context.runId === first.runId),
      true,
    );
    assert.equal(
      second.stateTransitions.every((record) => record.context.runId === second.runId),
      true,
    );
  });
});
