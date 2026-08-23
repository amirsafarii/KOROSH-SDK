import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../src/core/agent.js';
import { Tool } from '../src/core/tool.js';
import { ConfigurationError } from '../src/errors.js';
import { MockModel } from './helpers/mock-model.js';

const okModel = new MockModel({ script: ['fine'] });

describe('Agent creation and config validation', () => {
  it('constructs with valid config', () => {
    const agent = new Agent({
      name: 'a1',
      instructions: 'do things',
      model: okModel,
      tools: [],
    });
    assert.equal(agent.name, 'a1');
    assert.equal(agent.instructions, 'do things');
    assert.equal(agent.model, okModel);
    assert.deepEqual(agent.tools, []);
  });

  it('rejects missing / empty / non-string name', () => {
    for (const bad of [undefined, '', '   ', 42]) {
      assert.throws(
        () => new Agent({ name: bad, instructions: 'x', model: okModel }),
        ConfigurationError,
        `name=${String(bad)} should throw`,
      );
    }
  });

  it('rejects missing / empty instructions', () => {
    for (const bad of [undefined, '', null]) {
      assert.throws(
        () => new Agent({ name: 'a', instructions: bad, model: okModel }),
        ConfigurationError,
      );
    }
  });

  it('rejects a model without a call() function', () => {
    for (const bad of [undefined, null, {}, { call: 'nope' }]) {
      assert.throws(
        () => new Agent({ name: 'a', instructions: 'x', model: bad }),
        ConfigurationError,
      );
    }
  });

  it('rejects duplicate tool names at definition time', () => {
    const tool = () =>
      new Tool({
        name: 'dup',
        description: 'd',
        execute: () => 1,
      });
    assert.throws(
      () => new Agent({ name: 'a', instructions: 'x', model: okModel, tools: [tool(), tool()] }),
      (error) => error instanceof ConfigurationError && error.toolName === 'dup',
    );
  });

  it('rejects non-array tools', () => {
    assert.throws(
      () => new Agent({ name: 'a', instructions: 'x', model: okModel, tools: 'nope' }),
      ConfigurationError,
    );
  });
});

describe('Tool definition validation', () => {
  it('accepts valid tool and exposes model-facing descriptor', () => {
    const tool = new Tool({
      name: 'search',
      description: 'Search the web',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      execute: async ({ q }) => q,
    });
    const descriptor = tool.describe();
    assert.deepEqual(descriptor.name, 'search');
    assert.equal(descriptor.description, 'Search the web');
    assert.ok(descriptor.parameters.properties.q);
    // Descriptor must NOT leak the execute function.
    assert.equal(descriptor.execute, undefined);
  });

  it('rejects invalid names', () => {
    for (const bad of ['', 'has space', 'has.dot', null, undefined, 7]) {
      assert.throws(() => new Tool({ name: bad, description: 'd', execute() {} }), ConfigurationError);
    }
  });

  it('rejects empty description and missing execute', () => {
    assert.throws(
      () => new Tool({ name: 't', description: '', execute() {} }),
      ConfigurationError,
    );
    assert.throws(
      () => new Tool({ name: 't', description: 'd' }),
      ConfigurationError,
    );
  });

  it('defaults parameters to permissive object schema', () => {
    const tool = new Tool({ name: 't', description: 'd', execute() {} });
    assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: true });
  });
});
