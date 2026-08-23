/**
 * Stable public API for Phase 1.
 *
 * The public surface intentionally stays small: Agent, Tool, Runner, the
 * injectable logger, and the typed error hierarchy. Orchestration internals
 * remain importable via deep paths for tests and advanced integrations, but
 * they are not part of the stable package contract.
 */

export { Agent } from './core/agent.js';
export { Tool } from './core/tool.js';
export { Runner } from './loop/runner.js';
export { createConsoleLogger, nullLogger } from './logger.js';

export {
  FrameworkError,
  ConfigurationError,
  InputError,
  NormalizationError,
  ModelResultError,
  InvalidToolCallError,
  ModelError,
  LoopError,
  MaxTurnsError,
  ToolError,
  ToolNotFoundError,
  ToolValidationError,
  ToolExecutionError,
  ToolResultError,
} from './errors.js';
