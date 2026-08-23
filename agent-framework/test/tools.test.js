import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { SequentialStrategy } from '../src/tools/sequential-strategy.js';
import { toToolMessage } from '../src/tools/result.js';
import { validateArguments } from '../src/tools/strategy.js';
import { RunContext } from '../src/context/run-context.js';
import {
  ConfigurationError,
  ToolExecutionError,
  ToolNotFoundError,
  ToolValidationError,
  ToolResultError,
} from '../src/errors.js';
import { makeAgent, makeTool } from './helpers/fixtures.js';

// Minimal valid adapter — satisfies Agent validation; never actually called here.
const modelStub = {
  id: 'stub-model',
  async call() {
    return { final: 'unused', toolCalls: [] };
  },
};

describe('ToolRegistry', () => {
  it('register / get / has / list / remove / clear', () => {
    const registry = new ToolRegistry();
    const a = makeTool('a', () => 1);
    const b = makeTool('b', () => 2);

    assert.equal(registry.has('a'), false);
    registry.register(a);
    registry.register(b);
    assert.equal(registry.has('a'), true);
    assert.equal(registry.get('a'), a);

    // Registration order preserved.
    assert.deepEqual(registry.list().map((t) => t.name), ['a', 'b']);

    assert.equal(registry.remove('a'), true);
    assert.equal(registry.remove('never-there'), false);
    assert.equal(registry.has('a'), false);

    registry.clear();
    assert.deepEqual(registry.list(), []);
  });

  it('rejects duplicate registration instead of silent overwrite', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('dup', () => 1));
    assert.throws(
      () => registry.register(makeTool('dup', () => 2)),
      (error) => error instanceof ConfigurationError && error.toolName === 'dup',
    );
  });

  it('rejects non-tool entries', () => {
    const registry = new ToolRegistry();
    for (const bad of [null, undefined, 'x', {}, { name: 'half' }]) {
      assert.throws(() => registry.register(bad), ConfigurationError);
    }
  });
});

describe('validateArguments (schema subset)', () => {
  const schema = {
    type: 'object',
    properties: { q: { type: 'string' }, n: { type: 'number' }, flag: { type: 'boolean' } },
    required: ['q'],
  };

  it('accepts valid args', () => {
    assert.equal(validateArguments({ q: 'x', n: 1, flag: true }, schema).valid, true);
  });

  it('rejects missing required key', () => {
    const result = validateArguments({}, schema);
    assert.equal(result.valid, false);
    assert.match(result.message, /missing required argument "q"/);
  });

  it('rejects wrong types per property spec', () => {
    assert.equal(validateArguments({ q: 'x', n: 'one' }, schema).valid, false);
    assert.equal(validateArguments({ q: 'x', flag: 1 }, schema).valid, false);
  });

  it('non-object args rejected for object schemas; unknown type keywords pass', () => {
    assert.equal(validateArguments('nope', schema).valid, false);
    assert.equal(validateArguments({ x: 1 }, { type: 'weird' }).valid, true);
  });
});

describe('ToolExecutor pipeline (Lookup → Validate → Execute → Normalize)', () => {
  const runContext = new RunContext({
    agent: makeAgent({ model: modelStub }),
    metadata: { tenant: 't1' },
  });

  it('executes calls through the strategy and normalizes messages', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('add', ({ a, b }) => a + b, {
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    }));
    const executor = new ToolExecutor({ registry, strategy: new SequentialStrategy() });

    const { executions, messages } = await executor.executeCalls(
      [{ id: 'c1', name: 'add', arguments: { a: 2, b: 3 } }],
      { runContext, signal: null },
    );

    assert.equal(executions[0].status, 'success');
    assert.equal(executions[0].output, 5);
    assert.deepEqual(messages, [{ role: 'tool', toolCallId: 'c1', content: '5' }]);
  });

  it('fails fast on unknown tools with ToolNotFoundError carrying correlation ids', async () => {
    const executor = new ToolExecutor({ registry: new ToolRegistry() });
    await assert.rejects(
      () =>
        executor.executeCalls([{ id: 'c9', name: 'ghost', arguments: {} }], {
          runContext,
          signal: null,
        }),
      (error) =>
        error instanceof ToolNotFoundError &&
        error.toolName === 'ghost' &&
        error.toolCallId === 'c9' &&
        typeof error.runId === 'string' && // enriched by the loop layer
        error.cause === undefined,
    );
  });

  it('surfaces argument validation failure as an error result, not a throw', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('greet', ({ name }) => `hi ${name}`, {
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    }));
    const executor = new ToolExecutor({ registry, strategy: new SequentialStrategy() });

    const { executions, messages } = await executor.executeCalls(
      [{ id: 'c2', name: 'greet', arguments: { wrong: 1 } }],
      { runContext, signal: null },
    );

    assert.equal(executions[0].status, 'error');
    assert.ok(executions[0].error instanceof ToolValidationError);
    // Error results still normalize into a tool message so the loop can continue.
    assert.deepEqual(messages.length, 1);
    assert.deepEqual(JSON.parse(messages[0].content), { error: executions[0].error.message });
  });

  it('wraps thrown tool errors in ToolExecutionError preserving cause', async () => {
    const boom = new Error('disk on fire');
    const registry = new ToolRegistry();
    registry.register(makeTool('explode', () => {
      throw boom;
    }));
    const executor = new ToolExecutor({ registry, strategy: new SequentialStrategy() });

    const { executions } = await executor.executeCalls(
      [{ id: 'c3', name: 'explode', arguments: {} }],
      { runContext, signal: null },
    );
    assert.equal(executions[0].status, 'error');
    assert.ok(executions[0].error instanceof ToolExecutionError);
    assert.equal(executions[0].error.cause, boom);
    assert.equal(executions[0].error.toolName, 'explode');
  });

  it('passes runContext summary and abort signal into tools', async () => {
    let seenContext;
    let seenOptions;
    const controller = new AbortController();
    const registry = new ToolRegistry();
    registry.register(
      makeTool('spy', (args, context, options) => {
        seenContext = context;
        seenOptions = options;
        return 'ok';
      }),
    );
    const executor = new ToolExecutor({ registry, strategy: new SequentialStrategy() });
    await executor.executeCalls([{ id: 'c4', name: 'spy', arguments: {} }], {
      runContext,
      signal: controller.signal,
    });

    assert.equal(seenContext.runId, runContext.runId);
    assert.deepEqual(seenContext.metadata, { tenant: 't1' });
    assert.equal(seenOptions.signal, controller.signal);
  });

  it('returns empty artifacts for zero calls', async () => {
    const executor = new ToolExecutor({ registry: new ToolRegistry(), strategy: new SequentialStrategy() });
    const { executions, messages } = await executor.executeCalls([], { runContext, signal: null });
    assert.deepEqual(executions, []);
    assert.deepEqual(messages, []);
  });
});

describe('toToolMessage normalization', () => {
  it('serializes object outputs to JSON strings and passes strings through', () => {
    assert.deepEqual(toToolMessage({ toolCallId: 'c1', toolName: 't', status: 'success', output: { a: 1 } }), {
      role: 'tool',
      toolCallId: 'c1',
      content: '{"a":1}',
    });
    assert.deepEqual(toToolMessage({ toolCallId: 'c1', toolName: 't', status: 'success', output: 'raw' }).content, 'raw');
  });

  it('normalizes errors to {"error": message} content', () => {
    const message = toToolMessage({
      toolCallId: 'c2',
      toolName: 't',
      status: 'error',
      error: new ToolNotFoundError('not here', { toolName: 't' }),
    });
    assert.deepEqual(JSON.parse(message.content), { error: 'not here' });
  });

  it('rejects malformed requests', () => {
    assert.throws(() => toToolMessage({ toolName: 't', status: 'success' }), ToolResultError);
    assert.throws(
      () => toToolMessage({ toolCallId: 'c', toolName: 't', status: 'bogus' }),
      ToolResultError,
    );
  });
});
