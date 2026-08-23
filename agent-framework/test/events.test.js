import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Runner } from '../src/loop/runner.js';
import { EventBus, RunEvents } from '../src/events/bus.js';
import { MockModel } from './helpers/mock-model.js';
import { makeAgent, makeTool } from './helpers/fixtures.js';

describe('Event system', () => {
  it('emits the full success lifecycle in deterministic order', async () => {
    const model = new MockModel({
      script: [
        MockModel.toolCalls(MockModel.toolCall('c1', 't', {})),
        'done',
      ],
    });
    const tool = makeTool('t', () => 'ok');
    const runner = new Runner({ agent: makeAgent({ model, tools: [tool] }) });
    const seen = [];
    runner.events.on((e) => seen.push(e));

    const result = await runner.run('go');

    assert.equal(result.status, 'completed');
    const phaseOneTypes = seen
      .map((event) => event.type)
      .filter((type) => type !== RunEvents.RUN_STATE_CHANGED);
    assert.deepEqual(phaseOneTypes, [
      RunEvents.RUN_STARTED,
      RunEvents.TURN_STARTED,
      RunEvents.MODEL_STARTED,
      RunEvents.MODEL_COMPLETED,
      RunEvents.TOOL_STARTED,
      RunEvents.TOOL_COMPLETED,
      RunEvents.TURN_COMPLETED, // tool turn
      RunEvents.TURN_STARTED,
      RunEvents.MODEL_STARTED,
      RunEvents.MODEL_COMPLETED,
      RunEvents.TURN_COMPLETED, // final turn
      RunEvents.RUN_COMPLETED,
    ]);
  });

  it('event envelope carries id/type/timestamp/runId/turnId/data and is plain data', async () => {
    const runner = new Runner({ agent: makeAgent({ model: new MockModel({ script: ['x'] }) }) });
    const events = [];
    runner.events.on((e) => events.push(e));

    const result = await runner.run('hi');
    const started = events[0];

    assert.equal(started.type, RunEvents.RUN_STARTED);
    assert.equal(started.runId, result.runId);
    assert.equal(started.turnId, null);
    assert.equal(typeof started.id, 'string');
    assert.equal(typeof started.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(started.timestamp)));
    // Plain serializable — round-trips through JSON untouched.
    assert.deepEqual(JSON.parse(JSON.stringify(started)), started);

    // Turn-scoped events carry their turn id.
    const turnStarted = events.find((e) => e.type === RunEvents.TURN_STARTED);
    assert.equal(turnStarted.turnId, result.lastTurn.id);
  });

  it('failure lifecycle is ordered and ends with run.failed (no run.completed)', async () => {
    const loopingModel = {
      id: 'endless',
      async call() {
        return { final: null, toolCalls: [{ id: 'cx', name: 'noop', arguments: {} }] };
      },
    };
    const runner = new Runner({
      agent: makeAgent({ model: loopingModel, tools: [makeTool('noop', () => null)] }),
      maxTurns: 2,
    });
    const types = [];
    runner.events.on((e) => types.push(e.type));

    const result = await runner.run('spin');

    assert.equal(result.status, 'failed');
    assert.equal(types[types.length - 1], RunEvents.RUN_FAILED);
    assert.ok(!types.includes(RunEvents.RUN_COMPLETED));
    // Every RUN_STARTED has exactly one terminal event; turns pair start/end.
    let open = 0;
    for (const type of types) {
      if (type === RunEvents.TURN_STARTED) open += 1;
      if (type === RunEvents.TURN_COMPLETED) open -= 1;
      assert.ok(open >= 0 && open <= 1);
    }
    assert.equal(open, 0); // no dangling turn.started without completion
  });

  it('subscriber errors never break the run or later subscribers', async () => {
    const loggerCalls = [];
    const bus = new EventBus({
      logger: { debug() {}, info() {}, warn() {}, error(...args) { loggerCalls.push(args); } },
    });
    const healthy = [];
    bus.on(() => {
      throw new Error('subscriber bug');
    });
    bus.on((e) => healthy.push(e.type));
    const runner = new Runner({ agent: makeAgent({ model: new MockModel({ script: ['ok'] }) }), events: bus });

    const result = await runner.run('go');

    assert.equal(result.status, 'completed');
    assert.ok(healthy.length > 0); // second subscriber still received everything
    assert.equal(loggerCalls.length, healthy.length); // each failure was logged
  });

  it('unsubscribe stops event delivery', () => {
    const bus = new EventBus();
    const seen = [];
    const off = bus.on((e) => seen.push(e.type));
    bus.emit(RunEvents.RUN_STARTED, { runId: 'r1' });
    off();
    bus.emit(RunEvents.RUN_STARTED, { runId: 'r2' });
    assert.deepEqual(seen, [RunEvents.RUN_STARTED]);
  });
});

describe('Run isolation', () => {
  it('concurrent runs share no mutable state', async () => {
    // Model routes by first user message content so two runs diverge deterministically.
    const model = {
      id: 'router',
      async call(request) {
        const firstUser = request.input.find((m) => m.role === 'user').content;
        return { final: `answer:${firstUser}`, toolCalls: [] };
      },
    };
    const agent = makeAgent({ model });
    const runnerA = new Runner({ agent });
    const runnerB = new Runner({ agent });

    const [ra, rb] = await Promise.all([
      runnerA.run('from A'),
      runnerB.run('from B'),
    ]);

    assert.notEqual(ra.runId, rb.runId);
    assert.equal(ra.output, 'answer:from A');
    assert.equal(rb.output, 'answer:from B');
  });

  it('same runner sequential runs do not leak history between runs', async () => {
    const model = new MockModel({ script: ['a'], onExhausted: 'last' });
    const runner = new Runner({ agent: makeAgent({ model }) });
    await runner.run([{ role: 'user', content: 'one' }]);
    await runner.run([{ role: 'user', content: 'two' }]);
    // Second run's first request saw ONLY its own input.
    assert.deepEqual(model.requestAt(1).input, [{ role: 'user', content: 'two' }]);
  });

  it('caller-supplied metadata object is copied, not aliased', async () => {
    const runner = new Runner({ agent: makeAgent({ model: new MockModel({ script: ['x'] }) }) });
    const meta = { tag: 't1' };
    const result = await runner.run('hi', { metadata: meta });
    meta.tag = 'MUTATED';
    assert.equal(result.metadata.tag, 't1'); // run kept its own copy
  });

  it('run results are fully JSON-serializable', async () => {
    const model = new MockModel({
      script: [MockModel.toolCalls(MockModel.toolCall('c', 't', {})), 'final'],
    });
    const runner = new Runner({ agent: makeAgent({ model, tools: [makeTool('t', () => ({ ok: true }))] }) });
    const result = await runner.run('go');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });
});
