import { HTTPClient, type NodeRuntime } from '@chainlink/cre-sdk'

/**
 * `PerWorkflow.HTTPAction.ResponseSizeLimit`. A response at or above this is
 * not something the HTTP capability will hand back intact.
 *
 * Receipts are the one response in this flow whose size the caller does not
 * control: it grows with the transaction's log count, and a busy transaction
 * has been measured at ~110 KB. Everything else the library reads —
 * `eth_call`, the environment creation body — is bounded by something known in
 * advance.
 */
export const RESPONSE_SIZE_LIMIT = 250 * 1024

/** The SDK's own marshalling buffer ceiling, distinct from the platform quota. */
const SDK_BUFFER_MESSAGE = /response buffer too small/i
/**
 * Platform-side rejections, matched loosely because the wording is not
 * contractual. Every alternative names size explicitly: "exceeded" on its own
 * is just as likely to be a timeout or a call quota.
 */
const PLATFORM_SIZE_MESSAGE =
  /too large|size limit|(?:exceed|over)\w*\s+(?:the\s+)?(?:max(?:imum)?\s+)?(?:response\s+|body\s+|payload\s+)?size/i
/** A timeout is never a size rejection, whatever else the message says. */
const TIMEOUT_MESSAGE = /time\s*out|timed\s+out|deadline/i

/**
 * A response we could not use because of its size.
 *
 * Kept distinct from every other failure so that "this transaction is too
 * complex to inspect" is never reported as "Tenderly is unreachable". The two
 * call for completely different responses from an operator.
 *
 * Identifies the request by a label rather than its URL: most of these calls go
 * to the Admin RPC URL, which is a credential and ends up in the node log.
 */
export class ResponseTooLargeError extends Error {
  constructor(
    readonly label: string,
    readonly bytes: number | null,
    readonly limit: number,
  ) {
    super(
      bytes === null
        ? `${label} response was rejected for exceeding the ${limit} byte limit`
        : `${label} response was ${bytes} bytes, at or over the ${limit} byte limit`,
    )
    this.name = 'ResponseTooLargeError'
  }
}

/** True when a thrown capability error is really a size rejection. */
export const isSizeRejection = (message: string): boolean =>
  SDK_BUFFER_MESSAGE.test(message) ||
  (PLATFORM_SIZE_MESSAGE.test(message) && !TIMEOUT_MESSAGE.test(message))

export interface HttpOutcome {
  statusCode: number
  body: string
}

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'DELETE'
  url: string
  /** Names the request in errors and logs, which must never carry the URL itself. */
  label: string
  headers?: Record<string, string>
  body?: unknown
  /** Bytes at or above which the response is unusable. Defaults to the platform quota. */
  maxResponseBytes?: number
}

/**
 * One HTTP action. Counts against `PerWorkflow.HTTPAction.CallLimit`, so every
 * call site in this library is deliberate.
 *
 * Responses are never cached. Every node talks to its own Virtual Environment,
 * so there is nothing another node could reuse, and omitting `cacheSettings`
 * means the capability neither stores the response nor reads one back.
 *
 * Throws {@link ResponseTooLargeError} when the response is at or over the
 * limit, whether we measured it ourselves or the capability rejected it first.
 */
export const sendJson = (
  runtime: NodeRuntime<unknown>,
  options: HttpRequestOptions,
): HttpOutcome => {
  const limit = options.maxResponseBytes ?? RESPONSE_SIZE_LIMIT

  let response: { statusCode: number; body?: Uint8Array }
  try {
    response = new HTTPClient()
      .sendRequest(runtime, {
        method: options.method,
        url: options.url,
        body:
          options.body === undefined
            ? new Uint8Array()
            : new TextEncoder().encode(JSON.stringify(options.body)),
        multiHeaders: Object.fromEntries(
          Object.entries(options.headers ?? {}).map(([key, value]) => [key, { values: [value] }]),
        ),
      })
      .result()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The capability refused to hand the response back at all. We never see the
    // bytes, so the size is unknown, but the cause is not.
    if (isSizeRejection(message)) throw new ResponseTooLargeError(options.label, null, limit)
    throw error
  }

  const bytes = response.body?.length ?? 0
  // At the limit is already a failure: the response is either truncated or was
  // about to be refused, and either way it cannot be parsed with confidence.
  if (bytes >= limit) throw new ResponseTooLargeError(options.label, bytes, limit)

  return {
    statusCode: response.statusCode,
    body: new TextDecoder().decode(response.body),
  }
}

export const isSuccess = (statusCode: number): boolean => statusCode >= 200 && statusCode < 300
