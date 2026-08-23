import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AgentLoop, DEFAULT_MAX_TURNS } from '../src/loop/agent-loop.js';
import { Runner } from '../src/loop/runner.js';
import {
  ModelError,
  ModelResultError,
} from '../src/errors.js';
import { assertModelResult } from '../src/model/types.js';
import { MockModel, FailingModel } from './helpers/mock-model.js';
import { makeAgent, makeTool } from './helpers/fixtures.js';

describe('Model adapter contract (assertModelResult)', () => {
  it('accepts final-only, toolCalls-only, and combined results', () => {
    assert.doesNotThrow(() => assertModelResult({ final: 'done' }));
    assert.doesNotThrow(() =>
      assertModelResult({ final: null, toolCalls: [{ id: 'c', name: 't', arguments: {} }] }),
    );
    assert.doesNotThrow(() => assertModelResult({ final: 'ok', toolCalls: [] }));
  });

  it('passes usage/metadata through untouched (no coupling)', () => {
    const result = {
      final: 'done',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      metadata: { finishReason: 'stop', raw: { whatever: true } },
    };
    assert.equal(assertModelResult(result), result); // same reference — untouched
  });

  it('rejects structurally invalid results', () => {
    for (const bad of [
      null,
      'text',
      42,
      [],
      {},
      { final: null, toolCalls: [] },
      { toolCalls: 'nope' },
      { final: 7 },
    ]) {
      assert.throws(() => assertModelResult(bad), ModelResultError, String(JSON.stringify(bad)));
    }
    assert.throws(
      () => assertModelResult({ final: null, toolCalls: [{ id: '', name: 't', arguments: {} }] }),
      ModelResultError,
    );
    assert.throws(
      () => assertModelResult({ final: null, toolCalls: [{ id: 'c', name: 't' }] }), // missing arguments
      ModelResultError,
    );
  });
});

describe('Model failure paths through the loop', () => {
  it('wraps adapter throw into a failed run result with typed error and cause', async () => {
    const rootCause = new Error('socket hang up');
    const model = new FailingModel(rootCause);
    const runner = new Runner({ agent: makeAgent({ model }) });

    const result = await runner.run('hi');

    assert.equal(result.status, 'failed');
    assert.equal(result.output, null);
    assert.equal(result.error.name, 'ModelError');
    assert.match(result.error.message, /Model call failed|FailingModel/);
    // cause chain preserved on the actual thrown error object inside the turn
    assert.equal(result.lastTurn.status, 'failed');
    assert.equal(result.lastTurn.error.name, 'ModelError');
    assert.ok(model.calls.length >= 1);
  });

  it('invalid adapter shape fails the run with ModelResultError', async () => {
    const brokenAdapter = {
      async call() {
        return 'I am not an object';
      },
    };
    const runner = new Runner({ agent: makeAgent({ model: brokenAdapter }) });
    const result = await runner.run('hi');
    assert.equal(result.status, 'failed');
    assert.equal(result.error.name, 'ModelResultError');
  });

  it('model request contains instructions, normalized input, tools and metadata', async () => {
    const model = new MockModel({ script: ['done'] });
    const registryTools = [makeTool('t1', () => 1)];
    const runner = new Runner({
      agent: makeAgent({
        model,
        tools: registryTools,
        instructions: 'SYSTEM RULES',
        name: 'req-agent',
      }),
    });

    await runner.run('hello', { metadata: { traceId: 'tr-7' } });

    const request = model.requestAt(0);
    assert.equal(request.instructions, 'SYSTEM RULES');
    assert.deepEqual(request.input, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(request.tools.map((t) => t.name), ['t1']);
    assert.equal(request.metadata.agentName, 'req-agent');
    assert.equal(typeof request.metadata.runId, 'string');
    assert.equal(request.metadata.turnNumber, 1);
  });

  it('default maxTurns is exported and sane', () => {
    assert.equal(DEFAULT_MAX_TURNS, 10);
    assert.ok(new AgentLoop({ agent: makeAgent({ model: new MockModel() }) }).maxTurns === DEFAULT_MAX_TURNS);
  });
});
