/**
 * MockModel — deterministic, scripted model adapter for tests.
 *
 * A script is a list of "responses"; the Nth `call()` returns the Nth
 * response. When the script runs dry, `onExhausted` decides: 'error' throws
 * (default), or a final response object may be supplied. Every call records
 * its request so tests can assert exactly what the loop sent.
 *
 * No randomness, no timers — fully deterministic.
 */
import { ModelError } from '../../src/errors.js';

export class MockModel {
  /**
   * @param {object} [options]
   * @param {Array<object|string>} [options.script] responses; string = final text
   * @param {'error'|'last'} [options.onExhausted='error'] behavior past script end
   * @param {string} [options.id] model id reported in agent.describe()
   */
  constructor({ script = [], onExhausted = 'error', id = 'mock-model' } = {}) {
    this.id = id;
    this.#script = script.map(MockModel.normalizeResponse);
    this.#onExhausted = onExhausted;
    this.calls = []; // every request received, in order
    this.callCount = 0;
  }

  #script;
  #onExhausted;

  /** Model Adapter Contract: async call(request, options) => normalized result. */
  async call(request, options = {}) {
    if (options.signal?.aborted) {
      throw new ModelError('Model call aborted before start.', {
        runId: request.metadata?.runId,
        cause: new Error('AbortSignal was already aborted'),
      });
    }

    const index = this.callCount;
    this.callCount += 1;
    // Record what the loop sent while preserving AbortSignal identity, which
    // structuredClone would throw on.
    this.calls.push(cloneRequest(request));

    if (index >= this.#script.length) {
      if (this.#onExhausted === 'last' && this.#script.length > 0) {
        return structuredClone(this.#script[this.#script.length - 1]);
      }
      throw new ModelError(`MockModel script exhausted at call #${index + 1}.`);
    }
    // Fresh copy per call so a mutated result can't poison later calls.
    return structuredClone(this.#script[index]);
  }

  /** Convenience accessor for the request of the Nth call. */
  requestAt(index) {
    return this.calls.at(index);
  }

  /**
   * Accepts a plain response object or shorthand:
   *   'text'            → { final: 'text', toolCalls: [] }
   *   [{id,name,args}]  → toolCalls form via toolCall()
   */
  static normalizeResponse(response) {
    if (typeof response === 'string') {
      return { final: response, toolCalls: [] };
    }
    return response;
  }

  /** Builder for a tool-call response. */
  static toolCalls(...calls) {
    return { final: null, toolCalls: calls };
  }

  /** Builder for one tool call entry. */
  static toolCall(id, name, args) {
    return { id, name, arguments: args ?? {} };
  }
}

/** Model adapter that always fails — for failure-path tests. */
export class FailingModel {
  constructor(cause = new Error('provider outage')) {
    this.cause = cause;
    this.calls = [];
  }
  async call(request) {
    this.calls.push(cloneRequest(request));
    throw new ModelError('FailingModel invoked.', {
      runId: request.metadata?.runId,
      cause: this.cause,
    });
  }
}

function cloneRequest(request) {
  return {
    ...request,
    input: structuredClone(request.input),
    tools: structuredClone(request.tools),
    metadata: structuredClone(request.metadata),
    signal: request.signal,
  };
}
