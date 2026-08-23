import {
  ToolExecutionError,
  ToolResultError,
  ToolValidationError,
} from '../errors.js';

const REQUIRED_FIELDS = Object.freeze([
  'toolCallId',
  'toolName',
  'status',
  'output',
  'error',
]);

/** Validate a complete strategy result without reordering or repairing it. */
export function assertToolExecutionBatch(calls, executions) {
  if (!Array.isArray(executions)) {
    throw contractError('ExecutionStrategy must return an array.', {
      field: 'executions',
      expected: 'array',
      received: describeType(executions),
    });
  }
  if (executions.length !== calls.length) {
    throw contractError('ExecutionStrategy must return exactly one result per tool call.', {
      field: 'executions.length',
      expected: calls.length,
      received: executions.length,
    });
  }

  for (const [index, call] of calls.entries()) {
    assertToolExecutionRecord(call, executions[index], index);
  }
  return executions;
}

/** Validate one ToolExecution record against the call at the same batch index. */
export function assertToolExecutionRecord(call, execution, index) {
  if (execution === null || typeof execution !== 'object' || Array.isArray(execution)) {
    throw contractError('ExecutionStrategy result must be an object.', {
      executionIndex: index,
      expected: 'object',
      received: describeType(execution),
    });
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(execution, field)) {
      throw contractError(`ExecutionStrategy result is missing required field "${field}".`, {
        executionIndex: index,
        field,
        expected: 'present',
        received: 'missing',
      });
    }
  }

  if (execution.toolCallId !== call.id) {
    throw contractError('ExecutionStrategy result toolCallId does not match input order.', {
      executionIndex: index,
      field: 'toolCallId',
      expected: call.id,
      received: describeValue(execution.toolCallId),
    });
  }
  if (execution.toolName !== call.name) {
    throw contractError('ExecutionStrategy result toolName does not match its input call.', {
      executionIndex: index,
      field: 'toolName',
      expected: call.name,
      received: describeValue(execution.toolName),
    });
  }
  if (execution.status !== 'success' && execution.status !== 'error') {
    throw contractError('ExecutionStrategy result status must be success or error.', {
      executionIndex: index,
      field: 'status',
      expected: 'success|error',
      received: describeValue(execution.status),
    });
  }

  if (execution.status === 'success') {
    if (execution.error !== null) {
      throw contractError('Successful ToolExecution must have error set to null.', {
        executionIndex: index,
        field: 'error',
        expected: 'null',
        received: describeType(execution.error),
      });
    }
    return execution;
  }

  if (execution.output !== null) {
    throw contractError('Error ToolExecution must have output set to null.', {
      executionIndex: index,
      field: 'output',
      expected: 'null',
      received: describeType(execution.output),
    });
  }
  if (
    !(execution.error instanceof ToolValidationError) &&
    !(execution.error instanceof ToolExecutionError)
  ) {
    throw contractError(
      'Error ToolExecution must contain a ToolValidationError or ToolExecutionError.',
      {
        executionIndex: index,
        field: 'error',
        expected: 'ToolValidationError|ToolExecutionError',
        received: execution.error?.name ?? describeType(execution.error),
      },
    );
  }
  return execution;
}

function contractError(message, context) {
  return new ToolResultError(message, {
    contract: 'ExecutionStrategy.execute',
    ...context,
  });
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeValue(value) {
  return typeof value === 'string' ? value : describeType(value);
}
