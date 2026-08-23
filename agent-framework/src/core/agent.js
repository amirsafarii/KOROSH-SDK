import { ConfigurationError } from '../errors.js';

/**
 * Agent — a pure *definition*.
 *
 * Holds name, instructions, model and tools. It performs no execution; the
 * Runner/AgentLoop consume the definition at run time. Instances are deeply
 * frozen so a definition shared across concurrent runs cannot be mutated.
 */
export class Agent {
  /** @returns {string} stable agent identity used in run metadata and logs */
  get name() {
    return this.#name;
  }

  get instructions() {
    return this.#instructions;
  }

  /** Model adapter reference (never a provider client). */
  get model() {
    return this.#model;
  }

  /** @returns {readonly ToolDefinition[]} tools in registration order */
  get tools() {
    return this.#tools;
  }

  /**
   * @param {object} options
   * @param {string} options.name unique, non-empty agent name
   * @param {string} options.instructions system-level instructions for the model
   * @param {object} options.model a model adapter exposing `call(request, options)`
   * @param {Array} [options.tools] list of tool definitions or `{tool}` wrappers
   */
  constructor({ name, instructions, model, tools = [] }) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ConfigurationError('Agent requires a non-empty string "name".', {
        field: 'name',
      });
    }
    if (typeof instructions !== 'string' || instructions.length === 0) {
      throw new ConfigurationError('Agent requires a non-empty string "instructions".', {
        field: 'instructions',
      });
    }
    if (model == null || typeof model.call !== 'function') {
      throw new ConfigurationError(
        'Agent requires a "model" adapter exposing call(request, options).',
        { field: 'model' },
      );
    }
    if (!Array.isArray(tools)) {
      throw new ConfigurationError('Agent "tools" must be an array.', { field: 'tools' });
    }

    const seen = new Set();
    const normalizedTools = tools.map((entry) => normalizeToolEntry(entry, name));
    for (const tool of normalizedTools) {
      if (seen.has(tool.name)) {
        throw new ConfigurationError(
          `Agent "${name}" has duplicate tool name "${tool.name}".`,
          { field: 'tools', toolName: tool.name },
        );
      }
      seen.add(tool.name);
    }

    this.#name = name;
    this.#instructions = instructions;
    this.#model = model;
    // The tool array is owned and frozen by the Agent. Tool instances keep
    // their own private fields and are not deep-frozen by the Agent.
    this.#tools = Object.freeze([...normalizedTools]);
  }

  #name;
  #instructions;
  #model;
  #tools;

  /** Structural summary safe to embed in run results / events. */
  describe() {
    return {
      name: this.#name,
      model: modelId(this.#model),
      tools: this.#tools.map((t) => t.describe()),
    };
  }
}

function modelId(model) {
  return typeof model.id === 'string' && model.id.length > 0 ? model.id : 'anonymous-model';
}

/** Accepts either a Tool instance or `{ tool }` wrapper; validates shape via the tool itself. */
function normalizeToolEntry(entry, agentName) {
  if (entry == null || typeof entry !== 'object') {
    throw new ConfigurationError(
      `Agent "${agentName}" tools must contain tool definitions.`,
      { field: 'tools' },
    );
  }

  const candidate = entry.tool ?? entry;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.execute !== 'function' ||
    typeof candidate.describe !== 'function'
  ) {
    throw new ConfigurationError(
      `Agent "${agentName}" received an invalid tool definition.`,
      { field: 'tools', received: describeReceived(candidate) },
    );
  }

  return candidate;
}

function describeReceived(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
