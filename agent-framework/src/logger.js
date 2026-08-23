/**
 * Injectable logger contract: { debug, info, warn, error }.
 *
 * Core never logs directly and never imports console — hosts pass their own
 * implementation into Runner/EventBus. `createConsoleLogger` is a thin,
 * optional convenience for examples and quick starts.
 */
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/**
 * @param {{level?: 'debug'|'info'|'warn'|'error', sink?: object}} [options]
 * @returns {object} logger satisfying {debug,info,warn,error}
 */
export function createConsoleLogger({ level = 'info', sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (min) => (message, data) => {
    if (LEVELS[min] < threshold) return;
    const method = min === 'debug' ? 'log' : min;
    if (data === undefined) {
      sink[method](`[agent-framework] ${message}`);
    } else {
      sink[method](`[agent-framework] ${message}`, data);
    }
  };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

/** Logger that discards everything — used when no host logger is injected. */
export const nullLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});
