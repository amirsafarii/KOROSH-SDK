import { ConfigurationError } from '../errors.js';

/**
 * ToolRegistry — exactly what its name says: a registry.
 *
 * register / get / has / list / remove / clear. No execution, no policy.
 * `list()` preserves registration order so tool descriptors sent to the
 * model are deterministic across runs.
 */
export class ToolRegistry {
  constructor() {
    this.#tools = new Map();
  }

  #tools;

  /**
   * Register a Tool instance (or `{tool}` wrapper). Duplicate names throw —
   * silent overwrite would hide configuration mistakes.
   */
  register(tool) {
    const resolved = unwrap(tool);
    if (this.#tools.has(resolved.name)) {
      throw new ConfigurationError(`Tool "${resolved.name}" is already registered.`, {
        toolName: resolved.name,
      });
    }
    this.#tools.set(resolved.name, resolved);
    return resolved;
  }

  /** @returns {Tool|undefined} */
  get(name) {
    return this.#tools.get(name);
  }

  has(name) {
    return this.#tools.has(name);
  }

  /** @returns {Tool[]} registration order preserved */
  list() {
    return [...this.#tools.values()];
  }

  /** @returns {boolean} true when the name existed and was removed */
  remove(name) {
    return this.#tools.delete(name);
  }

  clear() {
    this.#tools.clear();
  }
}

function unwrap(entry) {
  const candidate = entry?.tool ?? entry;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.execute !== 'function' ||
    typeof candidate.describe !== 'function'
  ) {
    throw new ConfigurationError(
      'ToolRegistry.register expects a Tool instance ({name, execute, describe}).',
      { received: typeof entry },
    );
  }
  return candidate;
}
