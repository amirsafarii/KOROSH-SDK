import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Runner } from '../src/loop/runner.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { EventBus, RunEvents } from '../src/events/bus.js';
import { ConfigurationError } from '../src/errors.js';
import { MockModel } from './helpers/mock-model.js';
import { makeAgent, makeTool } from './helpers/fixtures.js';

describe('Runner (public API)', () => {
  it('requires an agent', () => {
    assert.throws(() => new Runner({}), ConfigurationError);
    assert.throws(() => new Runner({ agent: null }), ConfigurationError);
  });

  it('validates maxTurns, strategy and logger at construction', () => {
    const agent = makeAgent({ model: new MockModel() });
    assert.throws(() => new Runner({ agent, maxTurns: 0 }), ConfigurationError);
    assert.throws(() => new Runner({ agent, strategy: {} }), ConfigurationError);
    assert.throws(() => new Runner({ agent, logger: { info() {} } }), ConfigurationError);
  });

  it('returns structured RunResult with all mandated fields', async () => {
    const model = new MockModel({
      script: [MockModel.toolCalls(MockModel.toolCall('c', 't', {})), 'final!'],
    });
    const runner = new Runner({
      agent: makeAgent({ model, tools: [makeTool('t', () => 1)] }),
      metadata: undefined,
    });

    const result = await runner.run('go', { metadata: { k: 'v' } });

    // Shape contract
    for (const key of ['runId', 'status', 'output', 'turns', 'lastTurn', 'metadata']) {
      assert.ok(key in result, `result.${key} present`);
    }
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'final!');
    assert.ok(Array.isArray(result.turns) && result.turns.length === 2);
    assert.equal(result.lastTurn.id, result.turns.at(-1).id);
    assert.equal(result.metadata.k, 'v');
    assert.equal(result.metadata.agentName, 'test-agent');
    assert.ok(typeof result.metadata.durationMs === 'number');

    // Turn shape contract
    const turn = result.turns[0];
    for (const key of ['id', 'number', 'startedAt', 'endedAt', 'input', 'modelResult', 'toolCalls', 'toolResults', 'status']) {
      assert.ok(key in turn, `turn.${key} present`);
    }
    assert.deepEqual(turn.toolCalls, [{ id: 'c', name: 't', arguments: {} }]);
    assert.deepEqual(turn.toolResults, [
      { toolCallId: 'c', toolName: 't', status: 'success', output: 1 },
    ]);
  });

  it('accepts a custom registry overriding agent.tools (behavioral check)', async () => {
    // Model demands the custom tool; only the override registry has it.
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 'custom', {})),
        'used custom',
      ],
    });
    const registry = new ToolRegistry();
    registry.register(makeTool('custom', () => 'yes'));
    const runner = new Runner({
      agent: makeAgent({ model, tools: [] }), // agent itself declares NO tools
      registry,
    });

    const result = await runner.run('go');
    assert.equal(result.status, 'completed'); // unknown-tool failure would fail the run
  });

  it('shares one EventBus across runs of the same Runner; separate Runners are independent', async () => {
    const busA = new EventBus();
    const seenA = [];
    busA.on((e) => seenA.push(e));

    const runnerA1 = new Runner({ agent: makeAgent({ model: new MockModel({ script: ['x'] }) }), events: busA });
    const runnerA2 = new Runner({ agent: makeAgent({ model: new MockModel({ script: ['y'] }) }), events: busA });
    await runnerA1.run('1');
    await runnerA2.run('2');
    const phaseOneEvents = seenA.filter((event) => event.type !== RunEvents.RUN_STATE_CHANGED);
    assert.equal(phaseOneEvents.length, 12); // 6 Phase 1 events × 2 runs on the shared bus

    const before = seenA.length;
    const runnerB = new Runner({ agent: makeAgent({ model: new MockModel({ script: ['z'] }) }) });
    await runnerB.run('3');
    assert.equal(seenA.length, before); // B's events never touched A's bus
  });

  it('error results carry runId/turnId correlation for typed errors', async () => {
    const runner = new Runner({
      agent: makeAgent({ model: new MockModel({ script: [MockModel.toolCalls(MockModel.toolCall('c', 'ghost', {}))] }) }),
    });
    const result = await runner.run('go');
    assert.equal(result.status, 'failed');
    // Run-level error carries the run correlation.
    assert.equal(result.error.runId, result.runId);
    // Turn-level serialized error keeps tool correlation and the run id.
    assert.equal(result.lastTurn.error.name, 'ToolNotFoundError');
    assert.equal(result.lastTurn.error.context.toolName, 'ghost');
    assert.equal(result.lastTurn.error.context.runId, result.runId);
  });
});
