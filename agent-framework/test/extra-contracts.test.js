import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../src/core/agent.js';
import { Runner } from '../src/loop/runner.js';
import {
  ConfigurationError,
  InvalidToolCallError,
  ToolNotFoundError,
  ToolResultError,
} from '../src/errors.js';
import { MockModel } from './helpers/mock-model.js';
import { makeAgent, makeTool } from './helpers/fixtures.js';

describe('Additional Phase 1 contracts', () => {
  it('rejects invalid tool definitions at Agent construction', () => {
    assert.throws(
      () => new Agent({ name: 'a', instructions: 'x', model: new MockModel(), tools: [{}] }),
      ConfigurationError,
    );
    assert.throws(
      () => new Agent({ name: 'a', instructions: 'x', model: new MockModel(), tools: [{ tool: {} }] }),
      ConfigurationError,
    );
  });

  it('rejects malformed model tool calls with InvalidToolCallError', async () => {
    const model = {
      id: 'bad-calls',
      async call() {
        return { final: null, toolCalls: [{ id: 'c', name: 't' }] };
      },
    };
    const result = await new Runner({ agent: makeAgent({ model, tools: [makeTool('t', () => 1)] }) }).run('go');
    assert.equal(result.status, 'failed');
    assert.equal(result.error.name, 'InvalidToolCallError');
    assert.ok(result.error instanceof InvalidToolCallError === false); // serialized plain error
  });

  it('fails the run when a tool returns non-serializable output', async () => {
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 'cyclic', {})),
        'final',
      ],
    });
    const cyclic = {};
    cyclic.self = cyclic;
    const tool = makeTool('cyclic', () => cyclic);
    const result = await new Runner({ agent: makeAgent({ model, tools: [tool] }) }).run('go');

    assert.equal(result.status, 'failed');
    assert.equal(result.error.name, 'ToolResultError');
    assert.match(result.error.message, /non-serializable|serializable/);
    assert.equal(result.turns.length, 1);
  });

  it('emits deterministic tool.failed events for per-call tool errors and then completes', async () => {
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 'boom', {})),
        'recovered',
      ],
    });
    const runner = new Runner({
      agent: makeAgent({
        model,
        tools: [makeTool('boom', () => { throw new Error('boom'); })],
      }),
    });
    const types = [];
    runner.events.on((event) => types.push(event.type));

    const result = await runner.run('go');

    assert.equal(result.status, 'completed');
    assert.deepEqual(
      types.filter((type) => type.startsWith('tool.')),
      ['tool.started', 'tool.failed'],
    );
  });

  it('emits fatal tool.failed and no turn.completed tool results for unknown tools', async () => {
    const model = new MockModel({
      script: [MockModel.toolCalls(MockModel.toolCall('c1', 'missing', {}))],
    });
    const runner = new Runner({ agent: makeAgent({ model }) });
    const types = [];
    runner.events.on((event) => types.push(event.type));

    const result = await runner.run('go');

    assert.equal(result.status, 'failed');
    assert.equal(result.error.name, ToolNotFoundError.name);
    assert.deepEqual(
      types.filter((type) => type.startsWith('tool.')),
      ['tool.started', 'tool.failed'],
    );
    assert.equal(result.lastTurn.toolResults.length, 0);
  });
});
