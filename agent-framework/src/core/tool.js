import { ConfigurationError } from '../errors.js';
import { deepCopy, deepFreeze } from '../utils/objects.js';

/**
 * Tool — a self-validating definition: name, description, parameter schema
 * and an execute(args, context, options) implementation.
 *
 * A tool never depends on the Agent Loop. `options.signal` carries the run's
 * AbortSignal; `context` carries the read-only RunContext summary.
 */
export class Tool {
  get name() {
    return this.#name;
  }

  get description() {
    return this.#description;
  }

  /**
   * JSON-Schema-like parameter contract consumed by the executor's
   * validation step. Defaults to "any object accepted".
   */
  get parameters() {
    return this.#parameters;
  }

  /** @returns {(args, context, options) => Promise<any>|any} */
  get execute() {
    return this.#execute;
  }

  /**
   * @param {object} options
   * @param {string} options.name non-empty tool name (letters/digits/_/-)
   * @param {string} options.description human-readable purpose shown to the model
   * @param {object} [options.parameters] JSON-schema-ish spec for args validation
   * @param {Function} options.execute async (args, context, options) => output
   */
  constructor({ name, description, parameters = defaultParameters(), execute }) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new ConfigurationError(
        'Tool requires a non-empty "name" matching [A-Za-z0-9_-].',
        { field: 'name', toolName: name },
      );
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new ConfigurationError(`Tool "${name}" requires a non-empty string "description".`, {
        field: 'description',
        toolName: name,
      });
    }
    if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new ConfigurationError(`Tool "${name}" "parameters" must be a schema object.`, {
        field: 'parameters',
        toolName: name,
      });
    }
    if (typeof execute !== 'function') {
      throw new ConfigurationError(`Tool "${name}" requires an "execute" function.`, {
        field: 'execute',
        toolName: name,
      });
    }

    this.#name = name;
    this.#description = description;
    // Copy before freezing: a Tool definition must never mutate caller schema.
    this.#parameters = deepFreeze(deepCopy(parameters));
    this.#execute = execute;
  }

  #name;
  #description;
  #parameters;
  #execute;

  /** Model-facing descriptor — plain serializable, no execute reference. */
  describe() {
    return {
      name: this.#name,
      description: this.#description,
      parameters: this.#parameters,
    };
  }
}

function defaultParameters() {
  return { type: 'object', properties: {}, additionalProperties: true };
}
