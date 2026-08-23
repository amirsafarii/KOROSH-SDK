# Agent Framework

A production-oriented, provider-agnostic **Agent Loop / Orchestrator** core for Node.js. It is written in plain JavaScript with ESM, has no runtime dependencies, and keeps LLM providers, persistence, streaming, scheduling, retries and guardrails behind stable seams.

Phase 1 implements the deterministic core loop:

```text
User Input
  → Prepare Run
  → Prepare Turn
  → Model Call
  → Analyze Result
  → Final / Finish
     or
  → Tool Calls
  → Resolve / Validate / Execute / Normalize
  → Append Tool Results
  → Next Model Call
```

## Why this shape exists

The framework separates **definition** from **execution**:

- `Agent` is an immutable definition: `name`, `instructions`, `model`, `tools`.
- `Tool` is an independent definition with a schema and `execute(args, context, options)`.
- `Runner` is the public execution API.
- `AgentLoop`, `TurnRunner` behavior, `ToolExecutor`, `ToolRegistry`, `InputNormalizer`, `RunContext` and `EventBus` are internal orchestration components.
- A model provider is only connected through the **Model Adapter Contract**. Core never imports or understands provider-specific response formats.

## Requirements

- Node.js >= 20
- No npm install is required for core or tests.

## Run tests and examples

```bash
npm test
npm run test:verbose

npm run example:basic
npm run example:tool
npm run example:multi-turn
```

## Architecture and dependency direction

```text
Runner
  └─ AgentLoop
       ├─ InputNormalizer
       ├─ RunContext
       ├─ Turn
       ├─ Model Adapter (injected through Agent.model)
       ├─ ToolExecutor
       │    ├─ ToolRegistry
       │    └─ ExecutionStrategy
       │         └─ Tool.execute(args, context, options)
       ├─ Tool Result Normalizer
       └─ EventBus
```

Dependency rules:

1. Core never depends on a provider client.
2. Core never depends on persistence, Redis, Postgres, WebSockets or HTTP servers.
3. Provider-specific request/response mapping belongs in the host adapter.
4. Tool execution policy is injected through `ExecutionStrategy`.
5. Public API stays small; internals may be imported by advanced hosts via deep paths, but they are not stable across phases.

## Public API

```js
import { Agent, Tool, Runner } from './src/index.js';
```

Typed errors and optional logger utilities are also exported:

```js
import {
  MaxTurnsError,
  ModelError,
  ToolNotFoundError,
  ToolValidationError,
  ToolExecutionError,
  createConsoleLogger,
  nullLogger,
} from './src/index.js';
```

## Core concepts

### Agent

An `Agent` is a pure definition:

```js
const agent = new Agent({
  name: 'assistant',
  instructions: 'Be concise and use tools when needed.',
  model: myModelAdapter,
  tools: [myTool],
});
```

Agents are deeply frozen where practical and do not execute anything.

### Tool

A tool has:

- `name`
- `description`
- `parameters` — a small JSON-Schema-like object
- `execute(args, context, options)` — sync or async output

```js
const add = new Tool({
  name: 'add',
  description: 'Add two numbers.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  execute({ a, b }) {
    return a + b;
  },
});
```

Tool output must be JSON-serializable. It is normalized before being sent back to the model.

### Model Adapter Contract

Any object with this method is a valid model adapter:

```ts
async call(request, options) => NormalizedModelResult
```

Request produced by Core:

```js
{
  instructions: '...',
  input: [
    { role: 'user', content: '...' },
    { role: 'tool', toolCallId: 'call_1', content: '...' },
  ],
  tools: [
    {
      name: 'calculator',
      description: 'Add two numbers.',
      parameters: { /* ... */ },
    },
  ],
  metadata: {
    runId: 'run_...',
    turnNumber: 1,
    agentName: 'assistant',
    modelId: 'my-model',
  },
  signal: AbortSignal | null,
}
```

The adapter receives the caller's `AbortSignal` through both `options.signal` and `request.signal`. Core never wraps or replaces it.

Normalized result:

```js
{
  final: 'Answer text' | null,
  toolCalls: [
    {
      id: 'call_1',
      name: 'calculator',
      arguments: { a: 1, b: 2 },
    },
  ],
  usage: { inputTokens: 10, outputTokens: 5 }, // optional, passed through
  metadata: { finishReason: 'tool_calls' },     // optional, passed through
}
```

Rules:

- `final` may be omitted, `null`, or a string.
- `toolCalls` may be omitted or an array.
- At least one of `final` or a non-empty `toolCalls` must be present.
- Tool call `arguments` must already be parsed into an object by the adapter.
- Provider-specific fields may live under `usage` and `metadata`; Core does not couple to them.

### Runner

`Runner` owns shared infrastructure and creates a fresh isolated loop per run:

```js
const runner = new Runner({
  agent,
  maxTurns: 10,
  strategy: new SequentialStrategy(), // optional override
  logger: createConsoleLogger({ level: 'debug' }),
  events: myEventBus,                 // optional
  registry: myToolRegistry,           // optional override
});

const result = await runner.run('Hello', {
  signal: controller.signal,
  metadata: { traceId: 'trace-123' },
  runId: 'custom-run-id',
});
```

Structured result:

```js
{
  runId: 'run_...',
  status: 'completed' | 'failed',
  output: 'final answer' | null,
  error: { name, message, runId, turnId, cause } | undefined,
  turns: [
    {
      id: 'turn_...',
      number: 1,
      startedAt: 123,
      endedAt: 124,
      input: [/* internal messages */],
      modelResult: { /* normalized result */ },
      toolCalls: [/* ... */],
      toolResults: [/* ... */],
      status: 'completed' | 'failed',
    },
  ],
  lastTurn: { /* last turn snapshot */ },
  metadata: {
    agentName,
    startedAt,
    endedAt,
    durationMs,
    ...callerMetadata,
  },
}
```

### Run and Turn

- A **Run** is one complete invocation from user input to final output or failure.
- A **Turn** is one model-call cycle.
- Each run has its own `RunContext`, input copy, conversation history and turn data.
- Runs do not share mutable conversation state.
- Concurrent runs can safely share an `Agent`, `ToolRegistry`, `Runner` and injected strategy implementation as long as host code remains stateless.

### RunContext

`RunContext` identifies execution:

```js
{
  runId,
  agent,
  input,
  metadata,
  startedAt,
}
```

Tools receive a narrow read-only summary:

```js
{
  runId,
  agentName,
  metadata,
}
```

It is not persistence state and is not conversation history.

### InputNormalizer

Accepted public input:

```js
runner.run('A plain string');

runner.run({ text: 'Wrapped text' });
runner.run({ content: 'Wrapped content', role: 'user' });
runner.run({ messages: [{ role: 'user', content: 'Hello' }] });

runner.run([
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Hello.' },
]);
```

Input is copied and frozen internally. Caller objects are never mutated.

### ToolRegistry

```js
const registry = new ToolRegistry();
registry.register(tool);
registry.has('add');
registry.get('add');
registry.list();
registry.remove('add');
registry.clear();
```

Duplicate registration throws `ConfigurationError`.

### ToolExecutor and ExecutionStrategy

The tool pipeline is:

```text
Validate model tool calls
  → Resolve tool
  → Validate arguments
  → Execute
  → Normalize result
```

Phase 1 ships `SequentialStrategy`. It executes calls in model order. A future `ParallelStrategy` can be added without changing the loop because the loop depends only on the strategy contract.

Tool results enter the next model input as:

```js
{ role: 'tool', toolCallId: 'call_1', content: '...' }
```

Per-call validation/execution errors are represented as error tool results and sent back to the model. Missing tools fail the run with `ToolNotFoundError`.

### Events

Events are plain serializable envelopes:

```js
{
  id: 'evt_...',
  type: 'tool.completed',
  timestamp: '2026-01-01T00:00:00.000Z',
  runId: 'run_...',
  turnId: 'turn_...' | null,
  data: { /* ... */ },
}
```

Phase 1 event types:

- `run.started`
- `run.completed`
- `run.failed`
- `turn.started`
- `turn.completed`
- `model.started`
- `model.completed`
- `tool.started`
- `tool.completed`
- `tool.failed`

Subscriber errors are caught and logged; they never break the run.

### Logger

Core never logs directly. Inject any object matching:

```js
{
  debug(message, data) {},
  info(message, data) {},
  warn(message, data) {},
  error(message, data) {},
}
```

`createConsoleLogger({ level })` is available for examples and hosts that want console output.

### Errors

Typed errors preserve context and cause chains:

- `ConfigurationError`
- `InputError`
- `NormalizationError`
- `ModelResultError`
- `InvalidToolCallError`
- `ModelError`
- `LoopError`
- `MaxTurnsError`
- `ToolError`
- `ToolNotFoundError`
- `ToolValidationError`
- `ToolExecutionError`
- `ToolResultError`

Errors are not swallowed. Run results serialize error context, while thrown errors retain the original `cause`.

## Lifecycle ordering

For a successful tool → final run:

```text
run.started
  turn.started
    model.started
    model.completed
    tool.started
    tool.completed
  turn.completed
  turn.started
    model.started
    model.completed
  turn.completed
run.completed
```

For a fatal run failure, the last open turn is closed and the stream ends with `run.failed`; `run.completed` is never emitted.

`maxTurns` is a hard bound. If the model keeps requesting tools without final output, the run fails with `MaxTurnsError` instead of looping forever.

## Internal contracts

Internal modules are intentionally small:

- `src/core` — immutable definitions
- `src/loop` — run/turn orchestration
- `src/model` — normalized model contract and validation
- `src/tools` — registry, executor, strategy, result normalization
- `src/input` — public input normalization
- `src/events` — lifecycle event bus
- `src/context` — per-run context
- `src/utils` — IDs, time, object and serialization helpers

Results, turns, tool records and events are plain objects to support future persistence and streaming without changing the core shape.

## Phase 1 limitations

Phase 1 deliberately does **not** implement:

- full conversation/session state machine
- persistence, Redis, Postgres or files
- retry/backoff policies
- timeouts beyond host-controlled `AbortSignal`
- full parallel scheduling
- handoff engine
- distributed tracing
- usage aggregation
- WebSocket/SSE streaming
- guardrails

The seams for these features are present:

- `Runner` can be extended without changing `Agent` or `Tool`.
- `AgentLoop.callModel` is the future retry/tracing/streaming decoration seam.
- `ExecutionStrategy` is the future parallel scheduling seam.
- `EventBus` is the future streaming/tracing seam.
- Plain serializable run/turn/event objects support future persistence/recovery.

## Roadmap

Future phases are expected to add, in order or as scheduled:

1. State machine and richer run statuses
2. Advanced tool execution engine
3. Parallel scheduler
4. Full cancellation orchestration
5. Retry and timeout policies
6. Run-state persistence
7. Resume/recovery
8. Sessions
9. Usage and telemetry aggregation
10. Streaming via SSE/WebSocket
11. Handoff engine
12. Guardrails

## Design principles

- Lowest practical coupling
- Deterministic lifecycle and event ordering
- Provider-agnostic core
- Isolated runs
- Plain serializable data at boundaries
- Defensive copies for user/model/tool input
- Explicit typed errors
- Small public API
- No runtime dependencies
- No TypeScript in Phase 1
