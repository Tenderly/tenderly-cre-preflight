import { HttpActionsMock, newTestRuntime, type Secrets } from '@chainlink/cre-sdk/test'

export const SECRET_NAMESPACE = 'main'

export const secretsWith = (id: string, value: string): Secrets =>
  new Map([[SECRET_NAMESPACE, new Map([[id, value]])]])

export const runtimeWithSecret = (id: string, value: string) =>
  newTestRuntime(secretsWith(id, value))

export interface RecordedCall {
  method: string
  url: string
  body: Record<string, unknown> | null
}

export const decodeBody = (body: Uint8Array | undefined): Record<string, unknown> | null => {
  if (!body || body.length === 0) return null
  try {
    return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The harness expects the response body base64-encoded, as the host delivers it. */
export const jsonBody = (value: unknown): string => btoa(JSON.stringify(value))

export const rpcResult = (result: unknown) => ({
  statusCode: 200,
  body: jsonBody({ jsonrpc: '2.0', id: 1, result }),
})

export const rpcError = (message: string, data?: string, code = 3) => ({
  statusCode: 200,
  body: jsonBody({ jsonrpc: '2.0', id: 1, error: { code, message, ...(data ? { data } : {}) } }),
})

/** ABI-encoded `Error(string)` revert data, as a node returns it. */
export const errorString = (reason: string): string => {
  const bytes = new TextEncoder().encode(reason)
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const offset = '0'.repeat(62) + '20'
  const length = bytes.length.toString(16).padStart(64, '0')
  const padded = hex.padEnd(Math.ceil(bytes.length / 32) * 64, '0')
  return `0x08c379a0${offset}${length}${padded}`
}

export const ADMIN_RPC = 'https://virtual.sepolia.eu.rpc.tenderly.co/tenderly/acct/proj/abc-def'

/** Mirrors the real shape of POST /environments, captured from the live API. */
export const environmentResponse = (overrides: Record<string, unknown> = {}) => ({
  id: 'env-id-1',
  slug: '28a479',
  active_instance: {
    id: 'instance-1',
    vnets: [
      {
        id: 'vnet-1',
        status: 'running',
        fork_config: { network_id: 11155111, block_number: '0x5b8d80' },
        virtual_network_config: { chain_config: { chain_id: 11155111 } },
        rpcs: [{ url: ADMIN_RPC, name: 'Admin RPC' }],
      },
    ],
  },
  ...overrides,
})

/**
 * Installs an HTTP mock that records every call and dispatches on method+URL.
 * Returns the recording array so tests can assert on the HTTP action count.
 */
export const mockHttp = (
  handle: (call: RecordedCall) => { statusCode: number; body?: string },
): RecordedCall[] => {
  const calls: RecordedCall[] = []
  const http = HttpActionsMock.testInstance()
  http.sendRequest = (request) => {
    const call: RecordedCall = {
      method: String(request.method),
      url: String(request.url),
      body: decodeBody(request.body as Uint8Array | undefined),
    }
    calls.push(call)
    return handle(call)
  }
  return calls
}
