/**
 * Typed error hierarchy for the framework.
 *
 * Rules:
 *  - Every error carries a stable `name` for programmatic handling.
 *  - Contextual identifiers (runId / turnId / toolCallId / toolName) ride
 *    along as enumerable properties so errors stay plain-serializable.
 *  - `cause` is preserved for root-cause chains; nothing is ever swallowed.
 */

export class FrameworkError extends Error {
  constructor(message, options = {}) {
    const { cause, ...context } = options;
    // Only install `cause` when provided — never leak `cause: undefined`.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = new.target.name;
    // Enumerable context (runId, turnId, ...) — survives serialization.
    Object.assign(this, context);
  }
}

/** Thrown when an Agent or framework object is constructed with invalid config. */
export class ConfigurationError extends FrameworkError {}

/** Thrown for malformed run input (wrong type, empty message list, bad roles). */
export class InputError extends FrameworkError {}

/** Thrown by InputNormalizer when input cannot be represented internally. */
export class NormalizationError extends FrameworkError {}

/** Thrown when the model adapter returns a structurally invalid result. */
export class ModelResultError extends FrameworkError {}

/** Thrown when a normalized model result contains a malformed tool call entry. */
export class InvalidToolCallError extends ModelResultError {}

/** Thrown when the model adapter itself fails (network, provider error, abort). */
export class ModelError extends FrameworkError {}

/** Thrown when the loop cannot proceed (invariant violation, missing state). */
export class LoopError extends FrameworkError {}

/** Thrown when the agent exhausts `maxTurns` without producing a final output. */
export class MaxTurnsError extends FrameworkError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = MaxTurnsError.name;
  }
}

/** Base class for tool-pipeline failures. */
export class ToolError extends FrameworkError {}

/** Tool referenced in a model tool_call is not present in the registry. */
export class ToolNotFoundError extends ToolError {}

/** Tool arguments fail the tool's parameter schema validation. */
export class ToolValidationError extends ToolError {}

/** The tool's execute() threw — original error preserved as `cause`. */
export class ToolExecutionError extends ToolError {}

/** A tool result could not be normalized into the standard shape. */
export class ToolResultError extends ToolError {}
