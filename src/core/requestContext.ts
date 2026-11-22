/**
 * Per-request correlation context (ASAA ecosystem registry: correlation header X-Request-ID).
 * The request id is validated by the same rule as the site AI gateway (resolveRequestId).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
