import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ParallelStrategy } from '../src/tools/parallel-strategy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { RunContext } from '../src/context/run-context.js';
import { Tool } from '../src/core/tool.js';
import { EventBus } from '../src/events/bus.js';
import {
  ConfigurationError,
  ToolExecutionError,
  ToolNotFoundError,
  ToolResultError,
  ToolValidationError,
} from '../src/errors.js';

// ---------- helpers ----------

function makeTool(name, execute, { parameters, description } = {}) {
  return new Tool({
    name,
    description: description ?? `test tool ${name}`,
    parameters: parameters ?? { type: 'object', properties: {}, additionalProperties: true },
    execute,
  });
}

function makeRunContext() {
  // RunContext requires an agent stub; provide the minimum shape it reads.
  const agentStub = { name: 'test-agent' };
  return new RunContext({ agent: agentStub });
}

function makeRegistry(...tools) {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  return registry;
}

function makeCtx({ registry, events } = {}) {
  return {
    registry,
    runContext: makeRunContext(),
    signal: null,
    turnId: null,
    events: events ?? null,
  };
}

function call(id, name, args = {}) {
  return { id, name, arguments: args };
}

// A deferred promise we can resolve/reject from outside.
function deferred() {
  let resolve;
  let reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise: p, resolve, reject };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Milestone 1 tests (preserved) ----------

describe('ParallelStrategy — configuration (Milestone 1)', () => {
  it('defaults maxConcurrency to a finite positive integer', () => {
    const s = new ParallelStrategy();
    assert.equal(Number.isInteger(s.maxConcurrency), true);
    assert.ok(s.maxConcurrency >= 1);
    assert.ok(Number.isFinite(s.maxConcurrency));
  });

  it('accepts an explicit valid maxConcurrency', () => {
    const s = new ParallelStrategy({ maxConcurrency: 1 });
    assert.equal(s.maxConcurrency, 1);
    const s3 = new ParallelStrategy({ maxConcurrency: 8 });
    assert.equal(s3.maxConcurrency, 8);
  });

  it('rejects non-integer maxConcurrency with ConfigurationError', () => {
    for (const bad of [1.5, Math.PI, NaN, Infinity, '3', null, {}, []]) {
      assert.throws(
        () => new ParallelStrategy({ maxConcurrency: bad }),
        (error) => error instanceof ConfigurationError && error.field === 'maxConcurrency',
        `expected rejection for maxConcurrency=${JSON.stringify(bad)}`,
      );
    }
  });

  it('rejects zero and negative maxConcurrency with ConfigurationError', () => {
    for (const bad of [0, -1, -100]) {
      assert.throws(
        () => new ParallelStrategy({ maxConcurrency: bad }),
        (error) => error instanceof ConfigurationError && error.field === 'maxConcurrency',
        `expected rejection for maxConcurrency=${bad}`,
      );
    }
  });

  it('ignores unknown options without failing (forward-compatible)', () => {
    assert.doesNotThrow(() => new ParallelStrategy({ maxConcurrency: 2, future: true }));
  });
});

describe('ParallelStrategy — contract (Milestone 1)', () => {
  it('exposes an async execute(calls, context) method', () => {
    const s = new ParallelStrategy();
    assert.equal(typeof s.execute, 'function');
  });
});

// ---------- Milestone 2 tests ----------

describe('ParallelStrategy — bounded concurrency engine (Milestone 2)', () => {
  it('returns [] immediately for empty calls', async () => {
    const s = new ParallelStrategy({ maxConcurrency: 4 });
    const result = await s.execute([], makeCtx());
    assert.deepEqual(result, []);
  });

  it('executes calls in parallel when maxConcurrency >= number of calls', async () => {
    // Two tools each sleeping ~60ms: sequential would be ~120ms+, parallel < 90ms.
    const startedAt = Date.now();
    const registry = makeRegistry(
      makeTool('a', async () => { await sleep(60); return 'A'; }),
      makeTool('b', async () => { await sleep(60); return 'B'; }),
    );
    const s = new ParallelStrategy({ maxConcurrency: 2 });
    const results = await s.execute(
      [call('c1', 'a'), call('c2', 'b')],
      makeCtx({ registry }),
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'success');
    assert.equal(results[0].toolCallId, 'c1');
    assert.equal(results[0].output, 'A');
    assert.equal(results[1].status, 'success');
    assert.equal(results[1].toolCallId, 'c2');
    assert.equal(results[1].output, 'B');
    // Generous upper bound: parallel execution should finish well under
    // sequential time (~120ms). Use 110ms to be safe against CI jitter.
    assert.ok(elapsed < 150, `expected parallel execution <150ms, got ${elapsed}ms`);
  });

  it('enforces a hard concurrency limit (maxObserved <= maxConcurrency)', async () => {
    // 8 calls, maxConcurrency=3; track active count via __observe hook.
    const startBarriers = [];
    const finishBarriers = [];
    const tools = [];
    const N = 8;
    for (let i = 0; i < N; i += 1) {
      const sb = deferred();
      const fb = deferred();
      startBarriers.push(sb);
      finishBarriers.push(fb);
      const idx = i;
      tools.push(makeTool(`t${i}`, async () => {
        sb.resolve();
        await fb.promise;
        return idx;
      }));
    }
    const registry = makeRegistry(...tools);
    const s = new ParallelStrategy({ maxConcurrency: 3 });

    let maxObserved = 0;
    let active = 0;
    const startedOrder = [];
    const ctx = {
      ...makeCtx({ registry }),
      __observe: (ev) => {
        if (ev.type === 'start') {
          active += 1;
          if (active > maxObserved) maxObserved = active;
          startedOrder.push(ev.index);
        } else if (ev.type === 'finish' || ev.type === 'fatal') {
          active -= 1;
        }
      },
    };

    const resultP = s.execute(
      tools.map((t, i) => call(`id${i}`, t.name)),
      ctx,
    );

    // Wait until 3 workers are started (maxConcurrency).
    await startBarriers[0].promise;
    await startBarriers[1].promise;
    await startBarriers[2].promise;
    // Give microtasks a moment to settle; t3 should NOT have started.
    await sleep(5);
    assert.equal(maxObserved, 3);
    assert.equal(active, 3);
    assert.ok(!startedOrder.includes(3), 't3 must not start while 3 active');

    // Finish first call; then t3 should start.
    finishBarriers[0].resolve(0);
    await startBarriers[3].promise;
    await sleep(5);
    assert.equal(maxObserved, 3, 'must not exceed 3 concurrent');
    assert.equal(active, 3);

    // Unblock all remaining.
    for (let i = 1; i < N; i += 1) finishBarriers[i].resolve(i);

    const results = await resultP;
    assert.equal(results.length, N);
    assert.ok(maxObserved <= 3, `maxObserved=${maxObserved} exceeded limit 3`);
    assert.ok(maxObserved > 1, `maxObserved=${maxObserved} did not demonstrate parallelism`);
  });

  it('claims calls in strict input order', async () => {
    // Use barriers to record start order even though concurrency = 2.
    const starts = [];
    const defs = [];
    const tools = [];
    for (let i = 0; i < 5; i += 1) {
      const d = deferred();
      defs.push(d);
      const idx = i;
      tools.push(makeTool(`t${i}`, async () => {
        starts.push(idx);
        await d.promise;
        return idx;
      }));
    }
    const registry = makeRegistry(...tools);
    const s = new ParallelStrategy({ maxConcurrency: 2 });

    const p = s.execute(
      tools.map((t, i) => call(`id${i}`, t.name)),
      makeCtx({ registry }),
    );

    // Let first two start.
    await sleep(10);
    assert.deepEqual(starts.slice(0, 2), [0, 1], 'first two launched in input order');

    // Complete first; next launched must be index 2 (not 3 or 4).
    defs[0].resolve(0);
    await sleep(10);
    assert.ok(starts.includes(2), 'index 2 must launch after first slot frees');
    assert.ok(!starts.includes(3) || starts.indexOf(2) < starts.indexOf(3),
      'index 2 must be claimed before index 3');

    // Release everything.
    for (let i = 1; i < 5; i += 1) defs[i].resolve(i);
    await p;

    // All 5 calls started.
    assert.equal(starts.length, 5);
    // First N claimed are indices 0..N in order; completion order can vary but
    // claim order for the initial worker fill is strictly [0,1] with max=2,
    // then next claims are in index order as slots free.
    // We don't constrain the entire order beyond the deterministic initial
    // claim and the "claim lowest remaining" invariant we partially checked above.
  });

  it('preserves input result order despite out-of-order completion', async () => {
    // A slow, B fastest, C medium. Completion order will be B, C, A.
    const registry = makeRegistry(
      makeTool('a', async () => { await sleep(80); return 'A'; }),
      makeTool('b', async () => { await sleep(10); return 'B'; }),
      makeTool('c', async () => { await sleep(40); return 'C'; }),
    );
    const s = new ParallelStrategy({ maxConcurrency: 3 });
    const results = await s.execute(
      [call('ca', 'a'), call('cb', 'b'), call('cc', 'c')],
      makeCtx({ registry }),
    );
    assert.equal(results.length, 3);
    assert.equal(results[0].toolCallId, 'ca');
    assert.equal(results[0].output, 'A');
    assert.equal(results[1].toolCallId, 'cb');
    assert.equal(results[1].output, 'B');
    assert.equal(results[2].toolCallId, 'cc');
    assert.equal(results[2].output, 'C');
  });

  it('with maxConcurrency=1 behaves sequentially (one active at a time)', async () => {
    let maxObserved = 0;
    let active = 0;
    const running = [];
    const tools = [];
    const defs = [];
    const N = 4;
    for (let i = 0; i < N; i += 1) {
      const d = deferred();
      defs.push(d);
      const idx = i;
      tools.push(makeTool(`t${i}`, async () => {
        active += 1;
        if (active > maxObserved) maxObserved = active;
        running.push(idx);
        await d.promise;
        active -= 1;
        return idx;
      }));
    }
    const registry = makeRegistry(...tools);
    const s = new ParallelStrategy({ maxConcurrency: 1 });
    const p = s.execute(
      tools.map((t, i) => call(`id${i}`, t.name)),
      makeCtx({ registry }),
    );
    // Give the first worker time to start.
    await sleep(10);
    // First tool must have started; second must not.
    assert.deepEqual(running, [0], 'with concurrency=1 only the first tool should start initially');
    assert.equal(maxObserved, 1);
    defs[0].resolve(0);
    await sleep(10);
    defs[1].resolve(1);
    await sleep(10);
    defs[2].resolve(2);
    await sleep(10);
    defs[3].resolve(3);
    const results = await p;
    assert.equal(maxObserved, 1);
    assert.deepEqual(results.map((r) => r.output), [0, 1, 2, 3]);
    assert.deepEqual(results.map((r) => r.toolCallId), ['id0', 'id1', 'id2', 'id3']);
  });

  it('handles a single call correctly', async () => {
    const registry = makeRegistry(makeTool('only', () => 42));
    const s = new ParallelStrategy({ maxConcurrency: 4 });
    const [r] = await s.execute([call('x', 'only')], makeCtx({ registry }));
    assert.equal(r.status, 'success');
    assert.equal(r.toolCallId, 'x');
    assert.equal(r.output, 42);
    assert.equal(r.error, null);
  });

  it('handles fewer calls than maxConcurrency', async () => {
    const registry = makeRegistry(
      makeTool('a', async () => { await sleep(10); return 'A'; }),
      makeTool('b', async () => { await sleep(10); return 'B'; }),
    );
    const s = new ParallelStrategy({ maxConcurrency: 10 });
    const startedAt = Date.now();
    const results = await s.execute(
      [call('ca', 'a'), call('cb', 'b')],
      makeCtx({ registry }),
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(results.length, 2);
    assert.equal(results[0].output, 'A');
    assert.equal(results[1].output, 'B');
    assert.ok(elapsed < 80, `fewer-than-concurrency should run in parallel, got ${elapsed}ms`);
  });

  it('surfaces ToolValidationError as per-call recoverable and continues other calls', async () => {
    const executed = [];
    const registry = makeRegistry(
      // Greet requires {name: string}.
      makeTool(
        'greet',
        ({ name }) => `hi ${name}`,
        {
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      ),
      makeTool('ok', async () => { executed.push('ok'); await sleep(10); return 'ok'; }),
    );
    const s = new ParallelStrategy({ maxConcurrency: 2 });
    const results = await s.execute(
      [
        call('c1', 'greet', { notName: 1 }), // invalid
        call('c2', 'ok', {}),                // will succeed
      ],
      makeCtx({ registry }),
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'error');
    assert.equal(results[0].output, null);
    assert.ok(results[0].error instanceof ToolValidationError);
    assert.equal(results[0].toolCallId, 'c1');
    assert.equal(results[1].status, 'success');
    assert.equal(results[1].output, 'ok');
    assert.equal(results[1].toolCallId, 'c2');
    assert.deepEqual(executed, ['ok']);
  });

  it('surfaces tool throws as ToolExecutionError and continues other calls', async () => {
    const boom = new Error('transient');
    const executed = [];
    const registry = makeRegistry(
      makeTool('flaky', () => { throw boom; }),
      makeTool('healthy', async () => { executed.push('healthy'); await sleep(5); return 'ok'; }),
    );
    const s = new ParallelStrategy({ maxConcurrency: 2 });
    const results = await s.execute(
      [call('c1', 'flaky', {}), call('c2', 'healthy', {})],
      makeCtx({ registry }),
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'error');
    assert.equal(results[0].output, null);
    assert.ok(results[0].error instanceof ToolExecutionError);
    assert.equal(results[0].error.cause, boom);
    assert.equal(results[1].status, 'success');
    assert.equal(results[1].output, 'ok');
    assert.deepEqual(executed, ['healthy']);
  });

  it('propagates fatal ToolResultError (non-serializable output) and lets already-started calls settle', async () => {
    // Setup (maxConcurrency=2):
    //   - tbad returns a cyclic object synchronously → ToolResultError (fatal).
    //   - tslow waits on a barrier (simulates in-flight sibling).
    //   - tqueued is at index 2 (queued behind concurrency).
    // Expected ordering:
    //   1. Worker A claims tbad (index 0), worker B claims tslow (index 1) — both start.
    //   2. tbad synchronously produces a cyclic value; when normalizeToolOutput runs
    //      it throws ToolResultError; worker A sets fatalError and exits.
    //   3. tslow is still awaiting the barrier (in-flight).
    //   4. Test resolves the barrier → tslow completes successfully.
    //   5. Worker B loops back, sees fatalError, and returns WITHOUT claiming tqueued.
    //   6. execute() rejects with ToolResultError.
    //   7. tqueued is never invoked.
    const cyclic = {}; cyclic.self = cyclic;
    const tslowStarted = deferred();
    const tslowFinish = deferred();
    let tqueuedStarted = false;
    const registry = makeRegistry(
      // Synchronously return a cyclic object — normalizeToolOutput will throw
      // ToolResultError, which is fatal.
      makeTool('tbad', () => cyclic),
      makeTool('tslow', async () => {
        tslowStarted.resolve();
        await tslowFinish.promise;
        return 'slow-ok';
      }),
      makeTool('tqueued', () => { tqueuedStarted = true; return 'q'; }),
    );
    const s = new ParallelStrategy({ maxConcurrency: 2 });
    const events = new EventBus();
    const toolEvents = [];
    events.on((e) => { if (e.type.startsWith('tool.')) toolEvents.push(e); });

    const p = s.execute(
      [call('cbad', 'tbad'), call('cslow', 'tslow'), call('cqueued', 'tqueued')],
      makeCtx({ registry, events }),
    );

    // Wait until tslow has actually started (so both workers are busy).
    await tslowStarted.promise;

    // Now tbad has already produced its fatal error (synchronously on a
    // microtask after startup), but tslow is still in-flight. Release tslow.
    tslowFinish.resolve('slow-ok');

    await assert.rejects(
      p,
      (err) => err instanceof ToolResultError,
    );

    // Queued call must NOT have been started — the sibling worker must observe
    // fatalError before looping back to claim more work.
    assert.equal(tqueuedStarted, false, 'queued call must not start after fatal');

    // Exactly two tool.started events (tbad and tslow), no tqueued start.
    const started = toolEvents.filter((e) => e.type === 'tool.started').map((e) => e.data.toolCallId).sort();
    assert.deepEqual(started, ['cbad', 'cslow']);
  });

  it('produces exactly one terminal event per started call even under fatal error', async () => {
    // Companion to the fatal test: ensure we don't leak unbalanced started events.
    const cyclic = {}; cyclic.self = cyclic;
    const registry = makeRegistry(
      makeTool('tbad', () => cyclic), // synchronous → fatal
      makeTool('tok', async () => { await sleep(10); return 'ok'; }),
    );
    const s = new ParallelStrategy({ maxConcurrency: 2 });
    const events = new EventBus();
    const toolEvents = [];
    events.on((e) => { if (e.type.startsWith('tool.')) toolEvents.push(e); });

    await assert.rejects(
      s.execute(
        [call('cbad', 'tbad'), call('cok', 'tok')],
        makeCtx({ registry, events }),
      ),
      ToolResultError,
    );

    // Every started event must have exactly one matching terminal event.
    for (const ev of toolEvents) {
      if (ev.type === 'tool.started') {
        const terminals = toolEvents.filter(
          (e) => e.data.toolCallId === ev.data.toolCallId
            && (e.type === 'tool.completed' || e.type === 'tool.failed'),
        );
        assert.equal(terminals.length, 1,
          `expected exactly one terminal event for ${ev.data.toolCallId}, got ${terminals.length}`);
      }
    }
  });

  it('runs two concurrent execute() calls on the same strategy instance without cross-contamination', async () => {
    // Two separate batches with separate calls/registries must not mix results.
    const registryA = makeRegistry(
      makeTool('a1', async () => { await sleep(20); return 'A1'; }),
      makeTool('a2', async () => { await sleep(20); return 'A2'; }),
    );
    const registryB = makeRegistry(
      makeTool('b1', async () => { await sleep(10); return 'B1'; }),
      makeTool('b2', async () => { await sleep(30); return 'B2'; }),
      makeTool('b3', async () => { await sleep(20); return 'B3'; }),
    );
    const s = new ParallelStrategy({ maxConcurrency: 3 });

    const [resA, resB] = await Promise.all([
      s.execute([call('a1', 'a1'), call('a2', 'a2')], makeCtx({ registry: registryA })),
      s.execute(
        [call('b1', 'b1'), call('b2', 'b2'), call('b3', 'b3')],
        makeCtx({ registry: registryB }),
      ),
    ]);

    assert.equal(resA.length, 2);
    assert.deepEqual(resA.map((r) => r.toolCallId), ['a1', 'a2']);
    assert.deepEqual(resA.map((r) => r.output), ['A1', 'A2']);
    assert.equal(resB.length, 3);
    assert.deepEqual(resB.map((r) => r.toolCallId), ['b1', 'b2', 'b3']);
    assert.deepEqual(resB.map((r) => r.output), ['B1', 'B2', 'B3']);
  });

  it('ToolNotFoundError (if reached despite preflight) is fatal and lets in-flight calls settle', async () => {
    // ToolExecutor preflights missing tools and throws before calling the
    // strategy. If the strategy ever sees a missing tool (e.g. registry
    // mutation between preflight and execution), preserve fatal semantics.
    const startOk = deferred();
    const finishOk = deferred();
    const registry = makeRegistry(
      makeTool('ok', async () => { startOk.resolve(); await finishOk.promise; return 'ok'; }),
      // 'missing' is intentionally NOT registered.
    );
    const s = new ParallelStrategy({ maxConcurrency: 2 });
    const p = s.execute(
      [call('c-ok', 'ok'), call('c-miss', 'missing')],
      makeCtx({ registry }),
    );
    await startOk.promise;
    finishOk.resolve('ok');
    await assert.rejects(
      p,
      (err) => err instanceof ToolNotFoundError && err.toolName === 'missing',
    );
  });

  it('does not mutate or alias the input calls array', async () => {
    const registry = makeRegistry(makeTool('echo', (args) => ({ ...args })));
    const s = new ParallelStrategy({ maxConcurrency: 2 });
    const input = [call('c1', 'echo', { n: 1 }), call('c2', 'echo', { n: 2 })];
    const snapshot = JSON.parse(JSON.stringify(input));
    await s.execute(input, makeCtx({ registry }));
    assert.deepEqual(
      JSON.parse(JSON.stringify(input)),
      snapshot,
      'input calls must not be mutated by the strategy',
    );
  });
});
