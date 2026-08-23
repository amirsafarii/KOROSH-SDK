import assert from 'node:assert/strict';
import { Agent } from '../../src/core/agent.js';
import { Tool } from '../../src/core/tool.js';

/**
 * Shared test fixtures — tiny, deterministic agents/tools reused across the
 * suite so each test file focuses on behavior, not boilerplate.
 */

export function makeAgent({ model, tools = [], name = 'test-agent', instructions = 'You are a test agent.' } = {}) {
  return new Agent({ name, instructions, model, tools });
}

export function makeTool(name, execute, { parameters, description } = {}) {
  return new Tool({
    name,
    description: description ?? `Test tool "${name}"`,
    parameters,
    execute,
  });
}

/** Collect event types (and optionally full events) from a bus. */
export function collectEvents(bus) {
  const events = [];
  bus.on((event) => events.push(event));
  return {
    events,
    types: () => events.map((e) => e.type),
    assertExact(expected) {
      assert.deepEqual(
        events.map((e) => e.type),
        expected,
      );
    },
  };
}
