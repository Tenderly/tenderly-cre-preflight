import type { NodeRuntime } from '@chainlink/cre-sdk'
import { isSuccess, sendJson, type CacheOptions } from './http.js'

export interface RpcError {
  code: number
  message: string
  data?: string
  /**
   * Where the failure came from.
   *
   * `rpc` is the node answering: it understood the request and refused it, or
   * executed it and reported a problem. That is a result. `transport` is the
   * request never getting a usable answer at all, which tells us nothing about
   * the transaction.
   */
  kind: 'rpc' | 'transport'
}

/**
 * A JSON-RPC outcome, as a value rather than an exception.
 *
 * An EVM revert arrives as a JSON-RPC error but is a legitimate *answer* to the
 * question we asked. Throwing on it would make it indistinguishable from a
 * transport failure, so callers get the error and decide.
 */
export type RpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: RpcError }

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const jsonRpc = (
  runtime: NodeRuntime<unknown>,
  url: string,
  method: string,
  params: unknown[],
  cache: CacheOptions,
  maxResponseBytes?: number,
): RpcOutcome => {
  const response = sendJson(runtime, {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    // `id` is fixed so that every node builds a byte-identical request, which
    // is what makes the shared response cache able to match them.
    body: { jsonrpc: '2.0', id: 1, method, params },
    cache,
    maxResponseBytes,
  })

  if (!isSuccess(response.statusCode)) {
    return {
      ok: false,
      error: { code: response.statusCode, message: `HTTP ${response.statusCode}`, kind: 'transport' },
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    return {
      ok: false,
      error: { code: -1, message: `${method} returned a malformed JSON body`, kind: 'transport' },
    }
  }

  const envelope = asRecord(parsed)
  const error = asRecord(envelope?.error)
  if (error) {
    return {
      ok: false,
      error: {
        code: typeof error.code === 'number' ? error.code : -1,
        message: typeof error.message === 'string' ? error.message : 'unknown JSON-RPC error',
        data: typeof error.data === 'string' ? error.data : undefined,
        kind: 'rpc',
      },
    }
  }

  return { ok: true, result: envelope?.result }
}

export { asRecord }
