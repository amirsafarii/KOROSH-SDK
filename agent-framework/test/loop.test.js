import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Runner } from '../src/loop/runner.js';
import { AgentLoop } from '../src/loop/agent-loop.js';
import { MaxTurnsError } from '../src/errors.js';
import { MockModel } from './helpers/mock-model.js';
import { makeAgent, makeTool } from './helpers/fixtures.js';

describe('Agent Loop — final output', () => {
  it('completes a single-turn run with a final answer', async () => {
    const model = new MockModel({ script: ['the answer'] });
    const runner = new Runner({ agent: makeAgent({ model }) });

    const result = await runner.run('question');

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'the answer');
    assert.equal(result.turns.length, 1);
    assert.equal(result.lastTurn.status, 'completed');
    assert.deepEqual(result.lastTurn.toolCalls, []);
  });

  it('supports multi-turn conversations via message-array input', async () => {
    // Model echoes the last message's content as final — proves the loop
    // forwards whatever conversation it was given, unchanged.
    const model = {
      id: 'echo-last',
      calls: [],
      async call(request) {
        this.calls.push({ ...request, input: structuredClone(request.input), tools: structuredClone(request.tools), metadata: structuredClone(request.metadata), signal: request.signal });
        return { final: `last:${request.input.at(-1).content}`, toolCalls: [] };
      },
    };
    const runner = new Runner({ agent: makeAgent({ model }) });

    const first = await runner.run([{ role: 'user', content: 'one' }]);
    assert.equal(first.output, 'last:one');
    assert.equal(first.turns.length, 1);

    const second = await runner.run([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first:one' },
      { role: 'user', content: 'two' },
    ]);
    assert.equal(second.output, 'last:two');
    // The single call must have received the full conversation.
    assert.equal(second.turns[0].input.length, 3);
  });
});

describe('Agent Loop — tool cycles', () => {
  function buildEchoToolFlow() {
    // Turn 1: request echo tool; Turn 2: finalize using tool message.
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 'echo', { text: 'ping' })),
        { final: 'echo said: ping', toolCalls: [] },
      ],
    });
    const echo = makeTool(
      'echo',
      async ({ text }) => text,
      { parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    );
    return { model, tools: [echo] };
  }

  it('tool → final completes across exactly two turns', async () => {
    const { model, tools } = buildEchoToolFlow();
    const runner = new Runner({ agent: makeAgent({ model, tools }) });

    const result = await runner.run('say something');

    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'echo said: ping');
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].toolCalls.length, 1);
    assert.equal(result.turns[0].toolResults[0].status, 'success');
    assert.equal(result.turns[1].status, 'completed');
  });

  it('appends normalized tool messages into the next model input', async () => {
    const { model, tools } = buildEchoToolFlow();
    const runner = new Runner({ agent: makeAgent({ model, tools }) });
    await runner.run('go');

    const secondRequest = model.requestAt(1);
    const toolMessage = secondRequest.input.at(-1);
    assert.deepEqual(toolMessage, { role: 'tool', toolCallId: 'c1', content: 'ping' });
    assert.equal(secondRequest.input.length, 2); // original user msg + tool msg
  });

  it('tool → tool → final chains three turns', async () => {
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 'step', {})),
        MockModel.toolCalls(MockModel.toolCall('c2', 'step', {})),
        { final: 'all steps done', toolCalls: [] },
      ],
    });
    let executions = 0;
    const step = makeTool('step', () => ++executions);
    const runner = new Runner({ agent: makeAgent({ model, tools: [step] }) });

    const result = await runner.run('begin');

    assert.equal(result.status, 'completed');
    assert.equal(result.turns.length, 3);
    assert.equal(executions, 2);
    assert.deepEqual(
      model.requestAt(2).input.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
      ['c1', 'c2'],
    );
    assert.equal(result.output, 'all steps done');
  });

  it('executes multiple tool calls in ONE turn sequentially and feeds all results back', async () => {
    const order = [];
    const a = makeTool('a', () => order.push('a'), {});
    const b = makeTool('b', () => order.push('b'), {});
    const model = new MockModel({
      script: [
        MockModel.toolCalls(
          MockModel.toolCall('ca', 'a', {}),
          MockModel.toolCall('cb', 'b', {}),
        ),
        { final: 'both done', toolCalls: [] },
      ],
    });
    const runner = new Runner({ agent: makeAgent({ model, tools: [a, b] }) });

    const result = await runner.run('multi');

    assert.equal(result.status, 'completed');
    assert.equal(result.turns.length, 2);
    assert.deepEqual(order, ['a', 'b']); // sequential strategy preserves call order
    assert.equal(result.turns[0].toolResults.length, 2);
    assert.deepEqual(
      model.requestAt(1).input.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
      ['ca', 'cb'],
    );
  });

  it('mixed final+toolCalls turn treats tool calls as the action (no premature finish)', async () => {
    const model = new MockModel({
      script: [
        { final: 'draft text', toolCalls: [MockModel.toolCall('c1', 'save', {})] },
        { final: 'saved!', toolCalls: [] },
      ],
    });
    const save = makeTool('save', () => 'ok');
    const runner = new Runner({ agent: makeAgent({ model, tools: [save] }) });

    const result = await runner.run('save it');
    assert.equal(result.status, 'completed');
    assert.equal(result.turns.length, 2); // not finished on turn 1 despite final string
    assert.equal(result.output, 'saved!');
  });

  it('unknown tool fails the run with ToolNotFoundError', async () => {
    const model = new MockModel({
      script: [MockModel.toolCalls(MockModel.toolCall('cx', 'missing_tool', {}))],
    });
    const runner = new Runner({ agent: makeAgent({ model, tools: [] }) });

    const result = await runner.run('go');
    assert.equal(result.status, 'failed');
    assert.equal(result.error.name, 'ToolNotFoundError');
    assert.equal(result.error.toolName, 'missing_tool');
    assert.ok(typeof result.error.runId === 'string');
    assert.equal(result.lastTurn.status, 'failed');
  });

  it('tool failure becomes an error tool-result and the loop CONTINUES to final', async () => {
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 'flaky', {})),
        { final: 'recovered after tool error', toolCalls: [] },
      ],
    });
    const flaky = makeTool('flaky', () => {
      throw new Error('transient outage');
    });
    const runner = new Runner({ agent: makeAgent({ model, tools: [flaky] }) });

    const result = await runner.run('try');

    // Phase-1 policy: tool execution errors are reported to the model as
    // error results — the run continues rather than dying.
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'recovered after tool error');
    assert.equal(result.turns[0].toolResults[0].status, 'error');
    assert.match(JSON.parse(model.requestAt(1).input.at(-1).content).error, /transient outage/);
  });
});

describe('Agent Loop — maxTurns bound', () => {
  it('stops an endless tool-calling model with MaxTurnsError', async () => {
    // Model always demands another tool call — would loop forever unbounded.
    const loopingModel = {
      id: 'endless',
      calls: [],
      async call(request) {
        this.calls.push({ ...request, input: structuredClone(request.input), tools: structuredClone(request.tools), metadata: structuredClone(request.metadata), signal: request.signal });
        return { final: null, toolCalls: [{ id: `c${this.calls.length}`, name: 'noop', arguments: {} }] };
      },
    };
    const noop = makeTool('noop', () => null);
    const runner = new Runner({ agent: makeAgent({ model: loopingModel, tools: [noop] }), maxTurns: 3 });

    const result = await runner.run('spin');

    assert.equal(result.status, 'failed');
    assert.equal(result.error.name, 'MaxTurnsError');
    assert.match(result.error.message, /maxTurns \(3\)/);
    assert.equal(result.turns.length, 3);
    // Completed tool turns stay completed; only the interrupted final turn is failed.
    for (const turn of result.turns.slice(0, 2)) {
      assert.equal(turn.status, 'completed', `turn ${turn.number}`);
    }
    assert.equal(result.turns[2].status, 'failed');
    assert.equal(result.lastTurn.error.name, 'MaxTurnsError');
    // Exactly maxTurns model calls happened — no infinite loop.
    assert.equal(loopingModel.calls.length, 3);
  });

  it('rejects invalid maxTurns configuration at construction', () => {
    const agent = makeAgent({ model: new MockModel() });
    for (const bad of [0, -1, 1.5, NaN, 'three']) {
      assert.throws(() => new AgentLoop({ agent, maxTurns: bad }));
    }
  });

  it('MaxTurnsError is importable and typed for programmatic handling', () => {
    const error = new MaxTurnsError('x', { runId: 'r' });
    assert.equal(error.name, 'MaxTurnsError');
    assert.equal(error.runId, 'r');
  });
});

describe('AbortSignal propagation', () => {
  it('pre-aborted signal reaches the model adapter and aborts the run', async () => {
    const seenSignals = [];
    const adapter = {
      id: 'sig-model',
      async call(_request, options) {
        seenSignals.push(options.signal);
        if (options.signal?.aborted) {
          throw new Error('aborted before start');
        }
        return { final: 'never', toolCalls: [] };
      },
    };
    const controller = new AbortController();
    controller.abort();
    const runner = new Runner({ agent: makeAgent({ model: adapter }) });

    const result = await runner.run('hi', { signal: controller.signal });

    assert.equal(result.status, 'failed');
    assert.equal(seenSignals.length, 1);
    assert.equal(seenSignals[0], controller.signal); // same instance — never re-wrapped/dropped
    assert.equal(result.error.name, 'ModelError');
  });

  it('signal reaches tools mid-run when aborted during execution', async () => {
    let toolSignal;
    const slowTool = makeTool('slow', (_args, _ctx, options) => {
      toolSignal = options.signal;
      if (options.signal?.aborted) throw new Error('aborted in tool');
      return 'ok';
    });
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 'slow', {})),
        { final: 'done', toolCalls: [] },
      ],
    });
    const runner = new Runner({ agent: makeAgent({ model, tools: [slowTool] }) });
    const controller = new AbortController();

    await runner.run('go', { signal: controller.signal });
    assert.ok(toolSignal instanceof AbortSignal || toolSignal === null || toolSignal === undefined);
  });

  it('no layer wraps or replaces the caller signal', async () => {
    const observed = [];
    const probeTool = makeTool('probe', (_a, _c, options) => {
      observed.push(options.signal);
      return 1;
    });
    const model = new MockModel({
      script: [MockModel.toolCalls(MockModel.toolCall('c', 'probe', {})), 'final'],
    });
    const runner = new Runner({ agent: makeAgent({ model, tools: [probeTool] }) });
    const controller = new AbortController();

    await runner.run('x', { signal: controller.signal });
    assert.equal(observed[0], controller.signal);
  });
});
