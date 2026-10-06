import type { NodeRuntime } from '@chainlink/cre-sdk'
import { isSuccess, sendJson } from './http.js'
import { asRecord } from './rpc.js'
import type { ResolvedTenderlyConfig } from './config.js'

/** Only Tenderly hosts are ever contacted with an access key. */
const TENDERLY_HOST = /^https:\/\/(?:[a-z0-9-]+\.)+tenderly\.co(?:[/?#]|$)/i

/**
 * Tenderly answered, and refused. Carries the status so the caller can tell a
 * request that will never work (4xx: unsupported network, missing project,
 * unauthorised key) from Tenderly being temporarily unwell (5xx).
 */
export class EnvironmentRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'EnvironmentRequestError'
  }

  /** A 4xx is permanent: the config or the secret has to change. */
  get isPermanent(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500
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

/** One HTTP action. */
export const createEnvironment = (
  runtime: NodeRuntime<unknown>,
  config: ResolvedTenderlyConfig,
  accessKey: string,
  forkBlockNumber: bigint,
): CreatedEnvironment => {
  const networkConfig: Record<string, unknown> = {
    network_id: config.fork.networkId,
    block_number: `0x${forkBlockNumber.toString(16)}`,
    chain_config_overrides: { chain_id: config.fork.networkId },
  }
  if (config.region) networkConfig.region = config.region

  const response = sendJson(runtime, {
    method: 'POST',
    url: `${apiBase(config)}/environments`,
    headers: apiHeaders(accessKey),
    body: { display_name: config.displayName, network_configs: [networkConfig] },
    // Each node needs its own environment, so responses are never shared.
    cache: { store: false },
    maxResponseBytes: config.maxResponseBytes,
  })

  if (!isSuccess(response.statusCode)) {
    const detail = parseApiError(response.body)
    throw new EnvironmentRequestError(
      response.statusCode,
      detail || `environment creation returned HTTP ${response.statusCode}`,
    )
  }
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
      url: `${apiBase(config)}/environments/${environmentId}`,
      headers: apiHeaders(accessKey),
      cache: { store: false },
      maxResponseBytes: config.maxResponseBytes,
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
