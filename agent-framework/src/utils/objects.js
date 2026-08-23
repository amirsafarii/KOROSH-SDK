/**
 * Shared structural-clone / freeze helpers used across the framework.
 *
 * `structuredClone` is available globally in Node >= 17; we rely on it for
 * defensive copies of user-supplied data so no framework layer can mutate a
 * caller's objects (or vice versa) by accident.
 */

/** Deep-copy a plain value. Throws on non-cloneable values (functions, etc.) — callers pass plain data only. */
export function deepCopy(value) {
  return structuredClone(value);
}

/**
 * Deep-freeze an object graph (plain objects and arrays). Primitives are
 * returned untouched. Used to harden public contracts handed to user code
 * where mutation would corrupt run state.
 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}
