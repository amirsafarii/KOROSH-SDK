#!/usr/bin/env node
import { Agent, Runner, Tool } from '../src/index.js';

const calculator = new Tool({
  name: 'calculator',
  description: 'Add two numbers.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
    },
    required: ['a', 'b'],
  },
  execute({ a, b }) {
    return a + b;
  },
});

const model = {
  id: 'scripted-calculator',
  responses: [
    {
      final: null,
      toolCalls: [{ id: 'call_add', name: 'calculator', arguments: { a: 21, b: 21 } }],
    },
    {
      final: 'The answer is 42.',
      toolCalls: [],
    },
  ],
  async call() {
    return this.responses.shift();
  },
};

const agent = new Agent({
  name: 'math-assistant',
  instructions: 'Use tools when calculation is needed.',
  model,
  tools: [calculator],
});

const result = await new Runner({ agent }).run('What is 21 + 21?');

console.log(result.output);
console.log('Tool result:', result.lastTurn.input.at(-1).content);
