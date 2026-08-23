/**
 * Centralized timestamp helpers — every module derives times from these so a
 * Phase-later clock abstraction (fixed clock for tests, logical clock) can be
 * introduced in one place without touching callers.
 */
export const nowMs = () => Date.now();

export const timestamp = () => new Date(nowMs()).toISOString();
