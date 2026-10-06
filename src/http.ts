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
/** Platform-side rejections, matched loosely because the wording is not contractual. */
const PLATFORM_SIZE_MESSAGE = /(response|body|payload).{0,24}(too large|size limit|exceed)|exceed.{0,24}size/i

/**
 * A response we could not use because of its size.
 *
 * Kept distinct from every other failure so that "this transaction is too
 * complex to inspect" is never reported as "Tenderly is unreachable". The two
 * call for completely different responses from an operator.
 */
export class ResponseTooLargeError extends Error {
  constructor(
    readonly url: string,
    readonly bytes: number | null,
    readonly limit: number,
  ) {
    super(
      bytes === null
        ? `response from ${url} was rejected for exceeding the ${limit} byte limit`
        : `response from ${url} was ${bytes} bytes, at or over the ${limit} byte limit`,
    )
    this.name = 'ResponseTooLargeError'
  }
}

/** True when a thrown capability error is really a size rejection. */
export const isSizeRejection = (message: string): boolean =>
  SDK_BUFFER_MESSAGE.test(message) || PLATFORM_SIZE_MESSAGE.test(message)

export interface HttpOutcome {
  statusCode: number
  body: string
}

/**
 * Cache control for an outbound request.
 *
 * NOTE ON THE FIELD NAMES. The published CRE docs describe
 * `{ readFromCache: boolean, maxAgeMs: number }`. The shipped SDK does not have
 * those fields — `CacheSettings` is `{ store?: boolean, maxAge?: Duration }`,
 * where `maxAge` is protobuf-JSON, i.e. a string such as `'60s'`. Verified
 * against @chainlink/cre-sdk 1.16.0 and 1.22.0. We use the SDK's shape.
 */
export interface CacheOptions {
  /** Share this response with the other DON nodes. */
  store: boolean
  /** Longest acceptable age of a shared response, e.g. '60s'. Omit to always fetch. */
  maxAge?: string
}

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'DELETE'
  url: string
  headers?: Record<string, string>
  body?: unknown
  cache: CacheOptions
  /** Bytes at or above which the response is unusable. Defaults to the platform quota. */
  maxResponseBytes?: number
}

/**
 * One HTTP action. Counts against `PerWorkflow.HTTPAction.CallLimit`, so every
 * call site in this library is deliberate.
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
        cacheSettings: options.cache.maxAge
          ? { store: options.cache.store, maxAge: options.cache.maxAge }
          : { store: options.cache.store },
      })
      .result()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The capability refused to hand the response back at all. We never see the
    // bytes, so the size is unknown, but the cause is not.
    if (isSizeRejection(message)) throw new ResponseTooLargeError(options.url, null, limit)
    throw error
  }

  const bytes = response.body?.length ?? 0
  // At the limit is already a failure: the response is either truncated or was
  // about to be refused, and either way it cannot be parsed with confidence.
  if (bytes >= limit) throw new ResponseTooLargeError(options.url, bytes, limit)

  return {
    statusCode: response.statusCode,
    body: new TextDecoder().decode(response.body),
  }
}

export const isSuccess = (statusCode: number): boolean => statusCode >= 200 && statusCode < 300
