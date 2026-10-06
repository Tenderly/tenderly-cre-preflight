import type { NodeRuntime } from '@chainlink/cre-sdk'
import { isSuccess, sendJson } from './http.js'

export interface RpcError {
  code: number
  message: string
  data?: string
  /**
   * Where the failure came from.
   *
   * `rpc` is the node answering with a JSON-RPC error, whatever the HTTP
   * status: Tenderly sends some errors with a 4xx (see {@link classifyRpcError}).
   * `transport` is the request never getting a usable answer at all, which
   * tells us nothing about the transaction.
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
 * - `refused`: the node understood the request and turned it down on its merits,
 *   e.g. insufficient funds or a nonce conflict. That is an answer.
 * - `malformed`: the request itself can never succeed as written (unknown
 *   method, invalid params, a feature the network does not support, missing
 *   permission). Retrying cannot help.
 * - `transient`: anything else. The node could not serve the request right now,
 *   or answered in a way that tells us nothing about the transaction.
 *
 * The codes are the ones a Virtual Environment's RPC uses, not EIP-1474's,
 * which assigns several of the same numbers different meanings:
 *
 * - Every EVM-level error is code 3, as in geth: reverts, and also nonce too
 *   low or high, insufficient funds, intrinsic gas, and fee cap errors. -32015
 *   is a revert too.
 * - -32002 is NotSupported (e.g. a full `state` override), -32003 Unauthorized,
 *   -32004 Forbidden, -32006 BadRequest (e.g. `tenderly_setErc20Balance` when no
 *   balance slot can be found), -32007 BatchLimitExceeded.
 * - -32000 is a failure to read forked state upstream ("state ... not
 *   available"), next to -32097 and -32098; -32001 NotFound, -32005 rate
 *   limited, -32009 timeout, -32010 unavailable, -32099 unknown. None of these
 *   is an answer about the transaction.
 */
export type RpcErrorClass = 'transient' | 'malformed' | 'refused'

const REFUSED_CODES = new Set([3, -32015])
const MALFORMED_CODES = new Set([
  -32700, -32600, -32601, -32602, -32002, -32003, -32004, -32006, -32007,
])

export const classifyRpcError = (error: RpcError): RpcErrorClass => {
  if (error.kind === 'transport') return 'transient'
  if (REFUSED_CODES.has(error.code)) return 'refused'
  if (MALFORMED_CODES.has(error.code)) return 'malformed'
  return 'transient'
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

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    parsed = undefined
  }

  // Read the error before the status. Tenderly sends a JSON-RPC error with the
  // HTTP status of its category: 400 for BadRequest, 403, 408, 429. Treating
  // every non-2xx as a transport failure would discard the node's answer.
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

  if (!isSuccess(response.statusCode)) {
    return {
      ok: false,
      error: { code: response.statusCode, message: `HTTP ${response.statusCode}`, kind: 'transport' },
    }
  }
  if (!envelope) {
    return {
      ok: false,
      error: { code: -1, message: `${method} returned a malformed JSON body`, kind: 'transport' },
    }
  }

  return { ok: true, result: envelope.result }
}

export { asRecord }
