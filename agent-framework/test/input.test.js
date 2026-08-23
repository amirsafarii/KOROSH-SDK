import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeInput } from '../src/input/normalizer.js';
import { InputError, NormalizationError } from '../src/errors.js';

describe('Input normalization', () => {
  it('normalizes a bare string into a single user message', () => {
    assert.deepEqual(normalizeInput('hello'), [{ role: 'user', content: 'hello' }]);
  });

  it('normalizes a message array', () => {
    const input = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ];
    const result = normalizeInput(input);
    assert.deepEqual(result, input); // same values…
    assert.notEqual(result, input); // …fresh array
    assert.notEqual(result[0], input[0]); // fresh messages — no aliasing
  });

  it('unwraps {text}', () => {
    assert.deepEqual(normalizeInput({ text: 'hi' }), [{ role: 'user', content: 'hi' }]);
  });

  it('unwraps {content} with explicit role', () => {
    assert.deepEqual(normalizeInput({ content: 'hi', role: 'assistant' }), [
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('unwraps {messages}', () => {
    const messages = [{ role: 'user', content: 'a' }];
    assert.deepEqual(normalizeInput({ messages }), messages.map((m) => ({ ...m })));
  });

  it('preserves toolCallId on tool messages', () => {
    const result = normalizeInput([{ role: 'tool', toolCallId: 'c1', content: '42' }]);
    assert.equal(result[0].toolCallId, 'c1');
  });

  it('rejects invalid shapes with typed errors', () => {
    assert.throws(() => normalizeInput(42), InputError);
    assert.throws(() => normalizeInput(null), InputError);
    assert.throws(() => normalizeInput(undefined), InputError);
    assert.throws(() => normalizeInput({}), InputError); // no text/content/messages
    assert.throws(() => normalizeInput([]), InputError); // empty array
    assert.throws(
      () => normalizeInput([{ role: 'wizard', content: 'x' }]),
      NormalizationError,
    );
    assert.throws(
      () => normalizeInput([{ role: 'user', content: 5 }]),
      NormalizationError,
    );
    assert.throws(
      () => normalizeInput([{ role: 'tool', content: 'x' }]), // missing toolCallId
      NormalizationError,
    );
  });

  it('never mutates caller input', () => {
    const original = [{ role: 'user', content: 'original' }];
    const snapshot = structuredClone(original);
    normalizeInput(original);
    assert.deepEqual(original, snapshot);
  });
});
