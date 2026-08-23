/**
 * Plain-data serialization helpers.
 *
 * The public RunResult, Turn snapshots and event payloads must remain JSON
 * serializable so later persistence/streaming layers can reuse them unchanged.
 * Error instances are therefore converted into stable plain records at the
 * framework boundary.
 */

/**
 * Convert an error into a flat plain record.
 *
 * @param {unknown} error
 * @returns {{name:string,message:string,cause?:unknown,[key:string]:unknown}}
 */
export function toPlainError(error) {
  const base = {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
  };

  for (const [key, value] of Object.entries(error ?? {})) {
    if (isSerializableScalar(value)) {
      base[key] = value;
    }
  }

  const cause = error?.cause;
  if (cause !== undefined) {
    base.cause = cause instanceof Error ? toPlainError(cause) : sanitize(cause);
  }

  return base;
}

/**
 * Convert an error into the nested shape stored on Turn snapshots.
 * The nested `context` object keeps run/tool correlation explicit.
 */
export function toTurnError(error) {
  const context = {};
  for (const [key, value] of Object.entries(error ?? {})) {
    if (isSerializableScalar(value)) {
      context[key] = value;
    }
  }

  const record = {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    context,
  };

  if (error?.cause !== undefined) {
    record.cause = error.cause instanceof Error ? toPlainError(error.cause) : sanitize(error.cause);
  }

  return record;
}

/** Return a defensive JSON-safe copy of a plain value, or null if it cannot be cloned. */
export function plainCopy(value) {
  if (value === undefined) return null;
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

function sanitize(value) {
  if (value === null || isSerializableScalar(value)) return value;
  return plainCopy(value);
}

function isSerializableScalar(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
