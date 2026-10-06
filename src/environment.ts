import type { NodeRuntime } from '@chainlink/cre-sdk'
import { isSuccess, sendJson } from './http.js'
import { toHexQuantity } from './hex.js'
import { asRecord } from './rpc.js'
import type { ResolvedTenderlyConfig } from './config.js'

/** Only Tenderly hosts are ever contacted with an access key. */
const TENDERLY_HOST = /^https:\/\/(?:[a-z0-9-]+\.)+tenderly\.co(?:[/?#]|$)/i

/**
 * 4xx statuses that describe the moment rather than the request: a timeout, a
 * request sent too early, and rate limiting. A DON creating one environment per
 * node at the same instant is exactly the burst that gets a 429.
 */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429])

/**
 * Tenderly answered, and refused. Carries the status so the caller can tell a
 * request that will never work (unsupported network, missing project,
 * unauthorised key) from one that may work on the next run (5xx, rate limits).
 */
export class EnvironmentRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'EnvironmentRequestError'
  }

  /** Permanent: the config or the secret has to change before this can work. */
  get isPermanent(): boolean {
    return (
      this.statusCode >= 400 &&
      this.statusCode < 500 &&
      !RETRYABLE_CLIENT_STATUSES.has(this.statusCode)
    )
  }
}

/**
 * Pull Tenderly's own words out of an error body.
 *
 * Errors come back as `{ error: { slug, message } }`. Reporting that message
 * verbatim is the difference between "HTTP 400" and "Unsupported network id".
 */
export const parseApiError = (body: string): string => {
  try {
    const error = asRecord(asRecord(JSON.parse(body))?.error)
    const message = error?.message
    if (typeof message === 'string' && message) return message
  } catch {
    // fall through to the generic message below
  }
  return ''
}

export interface CreatedEnvironment {
  environmentId: string
  adminRpcUrl: string
  chainId: number
}

/**
 * Tenderly publishes exactly one API host. Holding it here rather than in
 * config means the access key has nowhere else it could be sent.
 */
const API_HOST = 'https://api.tenderly.co'

const apiBase = (config: ResolvedTenderlyConfig): string =>
  `${API_HOST}/api/public/v1/account/${config.accountSlug}/project/${config.projectSlug}`

const apiHeaders = (accessKey: string): Record<string, string> => ({
  accept: 'application/json',
  'content-type': 'application/json',
  'x-access-key': accessKey,
})

/**
 * Pull the environment id, Admin RPC URL, and chain id out of a create response.
 *
 * The chain id is read from the body on purpose. Confirming it with a follow-up
 * `eth_chainId` would spend an HTTP action to re-learn something the response
 * already stated.
 */
export const parseCreatedEnvironment = (body: string): CreatedEnvironment => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('environment creation returned a malformed JSON body')
  }

  const root = asRecord(parsed)
  const environmentId = root?.id
  if (typeof environmentId !== 'string' || !environmentId) {
    throw new Error('environment creation response omitted the environment id')
  }

  const instance = asRecord(root?.active_instance)
  const vnets = Array.isArray(instance?.vnets) ? instance.vnets : []
  const vnet = asRecord(vnets[0])
  if (!vnet) throw new Error('environment creation response contained no virtual network')

  const rpcs = Array.isArray(vnet.rpcs) ? vnet.rpcs.map(asRecord) : []
  // A real response carries four entries: 'Admin RPC', 'Admin websocket RPC',
  // 'Public RPC', 'Public websocket RPC'. A substring match on 'admin' matches
  // two of them, so it only picks the HTTP one by ordering luck. Match the
  // exact name, and never accept a websocket endpoint for JSON-RPC over HTTP.
  const admin = rpcs.find((rpc) => {
    if (typeof rpc?.name !== 'string' || typeof rpc.url !== 'string') return false
    if (rpc.name.trim().toLowerCase() !== 'admin rpc') return false
    return !/^wss?:/i.test(rpc.url)
  })
  const adminRpcUrl = admin?.url
  if (typeof adminRpcUrl !== 'string' || !TENDERLY_HOST.test(adminRpcUrl)) {
    throw new Error('environment creation response omitted a trusted Admin RPC URL')
  }

  const chainConfig = asRecord(asRecord(vnet.virtual_network_config)?.chain_config)
  const rawChainId = chainConfig?.chain_id
  const chainId =
    typeof rawChainId === 'number'
      ? rawChainId
      : typeof rawChainId === 'string'
        ? Number.parseInt(rawChainId, 10)
        : Number.NaN
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('environment creation response omitted a usable chain id')
  }

  return { environmentId, adminRpcUrl, chainId }
}

/**
 * The environment id alone, read as leniently as possible.
 *
 * Once Tenderly has created an environment, the only thing that matters for
 * cleanup is its id. Reading it separately from the full validation means a
 * response that fails any other check still gets its environment deleted.
 */
export const readEnvironmentId = (body: string): string | null => {
  try {
    const id = asRecord(JSON.parse(body))?.id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * One HTTP action.
 *
 * `onCreated` is called with the environment id as soon as Tenderly reports
 * one, before the rest of the response is validated, so the caller can always
 * clean up an environment that exists even when this throws.
 *
 * The response is held to the platform quota rather than `maxResponseBytes`.
 * The creation body is small and fixed in shape, and lowering the limit below
 * it would leave an environment that exists but whose id we refused to read.
 */
export const createEnvironment = (
  runtime: NodeRuntime<unknown>,
  config: ResolvedTenderlyConfig,
  accessKey: string,
  forkBlockNumber: bigint,
  onCreated: (environmentId: string) => void,
): CreatedEnvironment => {
  const networkConfig: Record<string, unknown> = {
    network_id: config.fork.networkId,
    block_number: toHexQuantity(forkBlockNumber),
    chain_config_overrides: { chain_id: config.fork.networkId },
  }
  if (config.region) networkConfig.region = config.region

  const response = sendJson(runtime, {
    method: 'POST',
    url: `${apiBase(config)}/environments`,
    label: 'environment creation',
    headers: apiHeaders(accessKey),
    body: { display_name: config.displayName, network_configs: [networkConfig] },
  })

  if (!isSuccess(response.statusCode)) {
    const detail = parseApiError(response.body)
    throw new EnvironmentRequestError(
      response.statusCode,
      detail || `environment creation returned HTTP ${response.statusCode}`,
    )
  }

  const environmentId = readEnvironmentId(response.body)
  if (environmentId) onCreated(environmentId)
  return parseCreatedEnvironment(response.body)
}

/** One HTTP action. Best effort: a failure here is logged, never thrown. */
export const deleteEnvironment = (
  runtime: NodeRuntime<unknown>,
  config: ResolvedTenderlyConfig,
  accessKey: string,
  environmentId: string,
): void => {
  try {
    const response = sendJson(runtime, {
      method: 'DELETE',
      url: `${apiBase(config)}/environments/${encodeURIComponent(environmentId)}`,
      label: 'environment deletion',
      headers: apiHeaders(accessKey),
    })
    if (!isSuccess(response.statusCode)) {
      runtime.log(`tenderly: cleanup of ${environmentId} returned HTTP ${response.statusCode}`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    runtime.log(`tenderly: cleanup of ${environmentId} failed: ${detail}`)
  }
}

export { apiBase }
