import type { NodeRuntime } from '@chainlink/cre-sdk'
import { isSuccess, sendJson } from './http.js'

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

/**
 * What a JSON-RPC error says about the request, as opposed to the transaction.
 *
 * - `transient`: the node could not serve the request right now (internal
 *   error, resource unavailable, rate limited). Retrying can help.
 * - `malformed`: the request itself can never succeed as written (parse error,
 *   unknown method, invalid params). Retrying cannot help.
 * - `refused`: the node understood the request and turned it down on its merits,
 *   e.g. insufficient funds or a nonce conflict. That is an answer.
 *
 * Codes from JSON-RPC 2.0 and EIP-1474. Anything not listed is `refused`, which
 * is where geth and Tenderly put transaction-level rejections (-32000, -32003).
 */
export type RpcErrorClass = 'transient' | 'malformed' | 'refused'

const TRANSIENT_CODES = new Set([-32603, -32002, -32005])
const MALFORMED_CODES = new Set([-32700, -32600, -32601, -32602, -32004, -32006])

export const classifyRpcError = (error: RpcError): RpcErrorClass => {
  if (error.kind === 'transport' || TRANSIENT_CODES.has(error.code)) return 'transient'
  if (MALFORMED_CODES.has(error.code)) return 'malformed'
  return 'refused'
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const jsonRpc = (
  runtime: NodeRuntime<unknown>,
  url: string,
  method: string,
  params: unknown[],
  maxResponseBytes?: number,
): RpcOutcome => {
  const response = sendJson(runtime, {
    method: 'POST',
    url,
    label: method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: { jsonrpc: '2.0', id: 1, method, params },
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
