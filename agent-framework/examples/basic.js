#!/usr/bin/env node
import { Agent, Runner } from '../src/index.js';

const scriptedModel = {
  id: 'scripted-final',
  async call(request) {
    const input = request.input;
    const last = input[input.length - 1]?.content ?? '';
    return {
      final: `Hello! I received: ${last}`,
      toolCalls: [],
    };
  },
};

const agent = new Agent({
  name: 'greeter',
  instructions: 'Answer briefly and clearly.',
  model: scriptedModel,
});

const runner = new Runner({ agent });
const result = await runner.run('What is an Agent Loop?');

console.log(result.output);
console.log(`Run ${result.runId} completed in ${result.turns.length} turn(s).`);
