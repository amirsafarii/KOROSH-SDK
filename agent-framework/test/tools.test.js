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
  InvalidToolCallError,
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

  it('validates registry and strategy dependencies at construction', () => {
    assert.throws(
      () => new ToolExecutor(),
      (error) => error instanceof ConfigurationError && error.field === 'registry',
    );
    assert.throws(
      () => new ToolExecutor({ registry: { get() {}, has() {} } }),
      (error) => error instanceof ConfigurationError && error.field === 'registry',
    );
    assert.throws(
      () => new ToolExecutor({ registry: new ToolRegistry(), strategy: {} }),
      (error) => error instanceof ConfigurationError && error.field === 'strategy',
    );

    assert.doesNotThrow(() => new ToolExecutor({ registry: new ToolRegistry() }));
  });

  it('validates the execution environment before invoking a tool', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(makeTool('probe', () => ++executions));
    const executor = new ToolExecutor({ registry });
    const calls = [{ id: 'c-env', name: 'probe', arguments: {} }];
    const invalidEnvironments = [
      undefined,
      null,
      {},
      { runContext: {} },
      { runContext: { runId: 'run_1' } },
      { runContext, events: {} },
    ];

    for (const env of invalidEnvironments) {
      await assert.rejects(() => executor.executeCalls(calls, env), ConfigurationError);
    }
    assert.equal(executions, 0);
  });

  it('rejects duplicate tool-call ids before strategy execution', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('noop', () => null));
    let strategyCalled = false;
    const executor = new ToolExecutor({
      registry,
      strategy: {
        async execute() {
          strategyCalled = true;
          return [];
        },
      },
    });

    await assert.rejects(
      () => executor.executeCalls(
        [
          { id: 'duplicate', name: 'noop', arguments: {} },
          { id: 'duplicate', name: 'noop', arguments: {} },
        ],
        { runContext },
      ),
      (error) =>
        error instanceof InvalidToolCallError &&
        error.toolCallId === 'duplicate' &&
        error.firstToolCallIndex === 0 &&
        error.toolCallIndex === 1,
    );
    assert.equal(strategyCalled, false);
  });

  function toolCall(id, name = 'tool') {
    return { id, name, arguments: {} };
  }

  function successExecution(call, output = 'ok') {
    return {
      toolCallId: call.id,
      toolName: call.name,
      status: 'success',
      output,
      error: null,
    };
  }

  function errorExecution(call, error) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      status: 'error',
      output: null,
      error,
    };
  }

  function executorReturning(calls, result, execute = () => 'unused') {
    const registry = new ToolRegistry();
    for (const name of new Set(calls.map((call) => call.name))) {
      registry.register(makeTool(name, execute));
    }
    return new ToolExecutor({
      registry,
      strategy: { async execute() { return result; } },
    });
  }

  async function executeStrategyResult(calls, result, execute) {
    return executorReturning(calls, result, execute).executeCalls(calls, { runContext });
  }

  it('rejects a non-array strategy result', async () => {
    const calls = [toolCall('c1')];
    for (const result of [null, {}, 'invalid']) {
      await assert.rejects(
        () => executeStrategyResult(calls, result),
        (error) =>
          error instanceof ToolResultError &&
          error.contract === 'ExecutionStrategy.execute' &&
          error.field === 'executions',
      );
    }
  });

  it('rejects an empty strategy result when calls exist', async () => {
    const calls = [toolCall('c1')];
    await assert.rejects(
      () => executeStrategyResult(calls, []),
      (error) =>
        error instanceof ToolResultError &&
        error.field === 'executions.length' &&
        error.expected === 1 &&
        error.received === 0,
    );
  });

  it('rejects too few strategy results', async () => {
    const calls = [toolCall('c1', 'a'), toolCall('c2', 'b')];
    await assert.rejects(
      () => executeStrategyResult(calls, [successExecution(calls[0])]),
      (error) =>
        error instanceof ToolResultError &&
        error.field === 'executions.length' &&
        error.expected === 2 &&
        error.received === 1,
    );
  });

  it('rejects too many strategy results', async () => {
    const calls = [toolCall('c1')];
    const results = [successExecution(calls[0]), successExecution(toolCall('c2'))];
    await assert.rejects(
      () => executeStrategyResult(calls, results),
      (error) =>
        error instanceof ToolResultError &&
        error.field === 'executions.length' &&
        error.expected === 1 &&
        error.received === 2,
    );
  });

  it('rejects a malformed strategy execution record', async () => {
    const calls = [toolCall('c1')];
    const malformed = {
      toolCallId: 'c1',
      toolName: 'tool',
      status: 'success',
      error: null,
    };
    await assert.rejects(
      () => executeStrategyResult(calls, [malformed]),
      (error) =>
        error instanceof ToolResultError &&
        error.executionIndex === 0 &&
        error.field === 'output' &&
        error.received === 'missing',
    );
  });

  it('rejects a strategy result with the wrong toolCallId', async () => {
    const calls = [toolCall('c1')];
    const result = successExecution({ id: 'wrong', name: 'tool' });
    await assert.rejects(
      () => executeStrategyResult(calls, [result]),
      (error) =>
        error instanceof ToolResultError &&
        error.field === 'toolCallId' &&
        error.expected === 'c1' &&
        error.received === 'wrong',
    );
  });

  it('rejects a strategy result with the wrong toolName', async () => {
    const calls = [toolCall('c1', 'expected')];
    const result = successExecution({ id: 'c1', name: 'wrong' });
    await assert.rejects(
      () => executeStrategyResult(calls, [result]),
      (error) =>
        error instanceof ToolResultError &&
        error.field === 'toolName' &&
        error.expected === 'expected' &&
        error.received === 'wrong',
    );
  });

  it('rejects a strategy result with an invalid status', async () => {
    const calls = [toolCall('c1')];
    const result = { ...successExecution(calls[0]), status: 'pending' };
    await assert.rejects(
      () => executeStrategyResult(calls, [result]),
      (error) => error instanceof ToolResultError && error.field === 'status',
    );
  });

  it('rejects an incoherent success execution record', async () => {
    const calls = [toolCall('c1')];
    const result = {
      ...successExecution(calls[0]),
      error: new ToolExecutionError('must not accompany success'),
    };
    await assert.rejects(
      () => executeStrategyResult(calls, [result]),
      (error) => error instanceof ToolResultError && error.field === 'error',
    );
  });

  it('rejects incoherent error execution records', async () => {
    const calls = [toolCall('c1')];
    const typedError = new ToolValidationError('invalid arguments');
    const wrongOutput = { ...errorExecution(calls[0], typedError), output: 'unexpected' };
    await assert.rejects(
      () => executeStrategyResult(calls, [wrongOutput]),
      (error) => error instanceof ToolResultError && error.field === 'output',
    );

    const missingError = errorExecution(calls[0], null);
    await assert.rejects(
      () => executeStrategyResult(calls, [missingError]),
      (error) => error instanceof ToolResultError && error.field === 'error',
    );
  });

  it('rejects reordered strategy execution records', async () => {
    const calls = [toolCall('c1', 'a'), toolCall('c2', 'b')];
    const reordered = [successExecution(calls[1]), successExecution(calls[0])];
    await assert.rejects(
      () => executeStrategyResult(calls, reordered),
      (error) =>
        error instanceof ToolResultError &&
        error.executionIndex === 0 &&
        error.field === 'toolCallId' &&
        error.expected === 'c1' &&
        error.received === 'c2',
    );
  });

  it('accepts a valid custom strategy result unchanged', async () => {
    const calls = [toolCall('c1', 'a'), toolCall('c2', 'b')];
    const validationError = new ToolValidationError('invalid arguments', {
      toolCallId: 'c2',
      toolName: 'b',
    });
    const expected = [
      successExecution(calls[0], { ok: true }),
      errorExecution(calls[1], validationError),
    ];

    const { executions, messages } = await executeStrategyResult(calls, expected);

    assert.equal(executions, expected);
    assert.deepEqual(messages[0], {
      role: 'tool',
      toolCallId: 'c1',
      content: '{"ok":true}',
    });
    assert.deepEqual(JSON.parse(messages[1].content), { error: 'invalid arguments' });
  });

  it('validates strategy output before conversation-message conversion', async () => {
    const calls = [toolCall('c1')];
    const cyclic = {};
    cyclic.self = cyclic;
    const result = {
      ...successExecution(calls[0], cyclic),
      status: 'pending',
    };

    await assert.rejects(
      () => executeStrategyResult(calls, [result]),
      (error) =>
        error instanceof ToolResultError &&
        error.contract === 'ExecutionStrategy.execute' &&
        error.field === 'status',
    );
  });

  it('does not invoke a registered tool for malformed custom strategy output', async () => {
    const calls = [toolCall('c1')];
    let toolInvocations = 0;

    await assert.rejects(
      () => executeStrategyResult(calls, {}, () => ++toolInvocations),
      ToolResultError,
    );
    assert.equal(toolInvocations, 0);
  });

  it('accepts existing SequentialStrategy execution records', async () => {
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
    assert.equal(executions[0].output, null);
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

    const { executions, messages } = await executor.executeCalls(
      [{ id: 'c3', name: 'explode', arguments: {} }],
      { runContext, signal: null },
    );
    assert.equal(executions[0].status, 'error');
    assert.equal(executions[0].output, null);
    assert.ok(executions[0].error instanceof ToolExecutionError);
    assert.equal(executions[0].error.cause, boom);
    assert.equal(executions[0].error.toolName, 'explode');
    assert.deepEqual(JSON.parse(messages[0].content), { error: executions[0].error.message });
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

  it('returns empty artifacts for zero calls without requiring an environment', async () => {
    const executor = new ToolExecutor({ registry: new ToolRegistry(), strategy: new SequentialStrategy() });
    const { executions, messages } = await executor.executeCalls([]);
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
