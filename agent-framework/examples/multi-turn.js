#!/usr/bin/env node
import { Agent, Runner, Tool } from '../src/index.js';

const notes = new Map();

const readNote = new Tool({
  name: 'read_note',
  description: 'Read a saved note by key.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
  },
  execute({ key }) {
    return notes.has(key) ? notes.get(key) : { missing: true, key };
  },
});

const writeNote = new Tool({
  name: 'write_note',
  description: 'Save a note by key.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['key', 'value'],
  },
  execute({ key, value }) {
    notes.set(key, value);
    return { saved: true, key };
  },
});

const model = {
  id: 'scripted-notes',
  async call(request) {
    const toolResults = request.input.filter((m) => m.role === 'tool').map((m) => m.content);

    if (toolResults.length === 0) {
      return {
        final: null,
        toolCalls: [{ id: 'call_write', name: 'write_note', arguments: { key: 'todo', value: 'Ship Phase 1' } }],
      };
    }

    if (toolResults.length === 1) {
      return {
        final: null,
        toolCalls: [{ id: 'call_read', name: 'read_note', arguments: { key: 'todo' } }],
      };
    }

    return { final: 'Multi-turn tool chain completed. Note: Ship Phase 1', toolCalls: [] };
  },
};

const agent = new Agent({
  name: 'note-agent',
  instructions: 'Persist and verify notes using tools.',
  model,
  tools: [writeNote, readNote],
});

const result = await new Runner({ agent }).run('Save and verify a todo note.');

for (const [index, turn] of result.turns.entries()) {
  console.log(`Turn ${index + 1}: ${turn.status}, tool calls: ${turn.toolCalls.length}`);
}
console.log(result.output);
