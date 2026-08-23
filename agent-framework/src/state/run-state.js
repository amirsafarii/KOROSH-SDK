export const RunStates = Object.freeze({
  CREATED: 'CREATED',
  PREPARING: 'PREPARING',
  WAITING_FOR_MODEL: 'WAITING_FOR_MODEL',
  PROCESSING_MODEL_RESULT: 'PROCESSING_MODEL_RESULT',
  EXECUTING_TOOLS: 'EXECUTING_TOOLS',
  PROCESSING_TOOL_RESULTS: 'PROCESSING_TOOL_RESULTS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const RunStateEvents = Object.freeze({
  PREPARE: 'PREPARE',
  REQUEST_MODEL: 'REQUEST_MODEL',
  MODEL_RESULT_RECEIVED: 'MODEL_RESULT_RECEIVED',
  EXECUTE_TOOLS: 'EXECUTE_TOOLS',
  TOOL_RESULTS_RECEIVED: 'TOOL_RESULTS_RECEIVED',
  COMPLETE: 'COMPLETE',
  FAIL: 'FAIL',
});

export const RunTransitions = Object.freeze({
  [RunStates.CREATED]: Object.freeze({
    [RunStateEvents.PREPARE]: RunStates.PREPARING,
    [RunStateEvents.FAIL]: RunStates.FAILED,
  }),
  [RunStates.PREPARING]: Object.freeze({
    [RunStateEvents.REQUEST_MODEL]: RunStates.WAITING_FOR_MODEL,
    [RunStateEvents.FAIL]: RunStates.FAILED,
  }),
  [RunStates.WAITING_FOR_MODEL]: Object.freeze({
    [RunStateEvents.MODEL_RESULT_RECEIVED]: RunStates.PROCESSING_MODEL_RESULT,
    [RunStateEvents.FAIL]: RunStates.FAILED,
  }),
  [RunStates.PROCESSING_MODEL_RESULT]: Object.freeze({
    [RunStateEvents.EXECUTE_TOOLS]: RunStates.EXECUTING_TOOLS,
    [RunStateEvents.COMPLETE]: RunStates.COMPLETED,
    [RunStateEvents.FAIL]: RunStates.FAILED,
  }),
  [RunStates.EXECUTING_TOOLS]: Object.freeze({
    [RunStateEvents.TOOL_RESULTS_RECEIVED]: RunStates.PROCESSING_TOOL_RESULTS,
    [RunStateEvents.FAIL]: RunStates.FAILED,
  }),
  [RunStates.PROCESSING_TOOL_RESULTS]: Object.freeze({
    [RunStateEvents.REQUEST_MODEL]: RunStates.WAITING_FOR_MODEL,
    [RunStateEvents.FAIL]: RunStates.FAILED,
  }),
  [RunStates.COMPLETED]: Object.freeze({}),
  [RunStates.FAILED]: Object.freeze({}),
});

export const TerminalRunStates = Object.freeze([
  RunStates.COMPLETED,
  RunStates.FAILED,
]);
