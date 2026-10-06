import { describe, expect } from 'bun:test'
import { test as creTest } from '@chainlink/cre-sdk/test'
import { TenderlyVNet, type TenderlyConfig } from '../src/index.js'
import {
  ADMIN_RPC,
  environmentResponse,
  jsonBody,
  mockHttp,
  rpcError,
  rpcResult,
  runtimeWithSecret,
  type RecordedCall,
} from './helpers.js'

const KEY_SECRET = 'tenderlyaccesskey'
const TX_HASH = `0x${'ab'.repeat(32)}`
const FROM = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'
const BLOCK = '0x5b8d81'

const base = {
  accountSlug: 'acct',
  projectSlug: 'proj',
  accessKeySecretId: KEY_SECRET,
  fork: { networkId: '11155111', at: '6000000' },
}

const tx = { from: FROM, to: TO, data: '0x', gas: '100000' }

const receipt = (status: string) => ({
  transactionHash: TX_HASH,
  from: FROM,
  to: TO,
  status,
  gasUsed: '0x5208',
  blockNumber: BLOCK,
})

const errorString = (reason: string): string => {
  const bytes = new TextEncoder().encode(reason)
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `0x08c379a0${'0'.repeat(62)}20${bytes.length.toString(16).padStart(64, '0')}${hex.padEnd(
    Math.ceil(bytes.length / 32) * 64,
    '0',
  )}`
}

const dispatcher =
  (overrides: Record<string, unknown> = {}) =>
  (call: RecordedCall) => {
    if (call.method === 'DELETE') return { statusCode: 204 }
    if (call.url.endsWith('/environments')) {
      return { statusCode: 200, body: jsonBody(environmentResponse()) }
    }
    const method = String(call.body?.method)
    if (method in overrides) {
      const value = overrides[method]
      return value instanceof Error ? rpcError(value.message, undefined, 3) : rpcResult(value)
    }
    if (method === 'tenderly_setBalance') return rpcResult('0x00')
    if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
    if (method === 'eth_getTransactionReceipt') return rpcResult(receipt('0x1'))
    if (method === 'eth_call') return rpcResult('0x')
    return { statusCode: 500, body: '' }
  }

const run = (config: TenderlyConfig = base, transaction = tx) =>
  new TenderlyVNet(config).sendTransaction(runtimeWithSecret(KEY_SECRET, 'access-key'), transaction)

describe('happy path', () => {
  creTest('creates, submits, reads the receipt, and deletes', () => {
    const calls = mockHttp(dispatcher())
    const verdict = run()

    expect(verdict.outcome).toBe('success')
    expect(verdict.reverted).toBeFalse()
    expect(verdict.gasUsed).toBe(21000n)
    // No eth_chainId: the chain id comes from the creation response. On the
    // success path the revert-explanation call is never spent, so this is four.
    expect(calls.map((c) => c.body?.method ?? c.method)).toEqual([
      'POST',
      'tenderly_sendTransaction',
      'eth_getTransactionReceipt',
      'DELETE',
    ])
  })

})

describe('the API host is not configurable', () => {
  creTest('always talks to api.tenderly.co, whatever the config says', () => {
    // The access key travels in an X-Access-Key header. With no host in config
    // there is nowhere else it could be sent, which is the point.
    const calls = mockHttp(dispatcher())
    run({ ...base, apiBaseUrl: 'https://evil.example.com' } as never)

    const api = calls.filter((c) => !c.url.includes('rpc.tenderly.co'))
    expect(api.length).toBeGreaterThan(0)
    for (const call of api) {
      expect(call.url.startsWith('https://api.tenderly.co/api/public/v1/')).toBeTrue()
    }
  })
})

describe('reverts', () => {
  creTest('reports a reverted receipt', () => {
    // A Virtual Environment accepts and mines a reverting transaction; the revert
    // never surfaces as a JSON-RPC error on tenderly_sendTransaction.
    mockHttp(dispatcher({ eth_getTransactionReceipt: receipt('0x0') }))
    const verdict = run()

    expect(verdict.outcome).toBe('reverted')
    expect(verdict.reverted).toBeTrue()
  })

  creTest('recovers the reason by replaying at the parent block', () => {
    const calls = mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      const method = String(call.body?.method)
      if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
      if (method === 'eth_getTransactionReceipt') return rpcResult(receipt('0x0'))
      if (method === 'eth_call') {
        return rpcError('execution reverted', errorString('ERC20: insufficient allowance'))
      }
      return { statusCode: 500, body: '' }
    })

    const verdict = run()
    expect(verdict.outcome).toBe('reverted')
    expect(verdict.reason).toBe('ERC20: insufficient allowance')

    // Replayed one block before the transaction, not at latest: by then the
    // chain already holds the state the revert left behind.
    const replay = calls.find((c) => c.body?.method === 'eth_call')
    expect((replay?.body?.params as unknown[])?.[1]).toBe('0x5b8d80')
  })

  creTest('skips the replay when explainReverts is off', () => {
    const calls = mockHttp(dispatcher({ eth_getTransactionReceipt: receipt('0x0') }))
    const verdict = run({ ...base, explainReverts: false })

    expect(verdict.outcome).toBe('reverted')
    expect(verdict.reason).toBe('')
    expect(calls.some((c) => c.body?.method === 'eth_call')).toBeFalse()
  })

  creTest('still reports the revert when the replay explains nothing', () => {
    mockHttp(dispatcher({ eth_getTransactionReceipt: receipt('0x0'), eth_call: '0x' }))
    const verdict = run()

    expect(verdict.outcome).toBe('reverted')
    expect(verdict.reason).toBe('')
  })
})

describe('failure handling', () => {
  creTest('rejects a receipt that does not match the submitted transaction', () => {
    mockHttp(dispatcher({ eth_getTransactionReceipt: { ...receipt('0x1'), to: FROM } }))
    expect(run().outcome).toBe('unavailable')
  })

  creTest('reports a pre-execution rejection as its own outcome', () => {
    // The node refused the transaction before running it. That is an answer —
    // send this and it fails — so it is neither a revert nor an outage.
    mockHttp(
      dispatcher({ tenderly_sendTransaction: new Error('insufficient funds for gas * price + value') }),
    )
    const verdict = run()
    expect(verdict.outcome).toBe('rejected')
    expect(verdict.reverted).toBeFalse()
    expect(verdict.reason).toContain('insufficient funds')
  })

  creTest('a transport failure on the same call is still unavailable', () => {
    // No usable answer came back at all, so we learned nothing about the
    // transaction. That must not look like a verdict.
    mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      return { statusCode: 502, body: '' }
    })
    expect(run().outcome).toBe('unavailable')
  })

  creTest('deletes the environment even when a later step fails', () => {
    const calls = mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      return { statusCode: 500, body: '' }
    })

    expect(run().outcome).toBe('unavailable')
    expect(calls.at(-1)?.method).toBe('DELETE')
    expect(calls.at(-1)?.url).toEndWith('/environments/env-id-1')
  })

  creTest('does not attempt cleanup when creation itself failed', () => {
    const calls = mockHttp(() => ({ statusCode: 500, body: '' }))
    expect(run().outcome).toBe('unavailable')
    expect(calls).toHaveLength(1)
  })

  creTest('reports a rejected request as misconfigured, not unavailable', () => {
    // An unsupported network is permanent: a cron would otherwise retry it
    // forever while reporting that Tenderly is down.
    const calls = mockHttp(() => ({
      statusCode: 400,
      body: jsonBody({ error: { slug: 'invalid_request', message: 'Unsupported network id' } }),
    }))
    const verdict = run()

    expect(verdict.outcome).toBe('misconfigured')
    expect(verdict.reason).toBe('Unsupported network id')
    expect(calls).toHaveLength(1)
  })

  creTest('a missing project and an unauthorised key are misconfigured too', () => {
    for (const [statusCode, message] of [
      [403, 'Insufficient permissions'],
      [404, 'Project not found'],
    ] as const) {
      mockHttp(() => ({ statusCode, body: jsonBody({ error: { message } }) }))
      const verdict = run()
      expect(verdict.outcome).toBe('misconfigured')
      expect(verdict.reason).toBe(message)
    }
  })

  creTest('falls back to the status code when the error body is unreadable', () => {
    mockHttp(() => ({ statusCode: 400, body: btoa('<html>nope</html>') }))
    expect(run().reason).toBe('environment creation returned HTTP 400')
  })

  creTest('a 5xx stays unavailable: Tenderly is unwell, not the config', () => {
    mockHttp(() => ({ statusCode: 503, body: jsonBody({ error: { message: 'upstream' } }) }))
    expect(run().outcome).toBe('unavailable')
  })

  creTest('rejects a creation response with no trusted Admin RPC', () => {
    mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        const body = environmentResponse()
        body.active_instance.vnets[0]!.rpcs = [
          { url: 'https://evil.example.com/rpc', name: 'Admin RPC' },
        ]
        return { statusCode: 200, body: jsonBody(body) }
      }
      return { statusCode: 500, body: '' }
    })
    expect(run().outcome).toBe('unavailable')
  })

  creTest('rejects a fork whose chain id is not the one requested', () => {
    mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        const body = environmentResponse()
        body.active_instance.vnets[0]!.virtual_network_config.chain_config.chain_id = 1
        return { statusCode: 200, body: jsonBody(body) }
      }
      return { statusCode: 500, body: '' }
    })
    expect(run().outcome).toBe('unavailable')
  })

  creTest('fails loudly when the secret is not configured', () => {
    // A missing secret is a deployment error, not a transient condition, so it
    // throws rather than degrading to `unavailable`. It throws in DON mode,
    // before any HTTP action is spent.
    const calls = mockHttp(dispatcher())
    expect(() =>
      new TenderlyVNet(base).sendTransaction(runtimeWithSecret('someothersecret', 'k'), tx),
    ).toThrow(/secret retrieval failed/)
    expect(calls).toHaveLength(0)
  })

  creTest('fails loudly when the secret is configured but empty', () => {
    const calls = mockHttp(dispatcher())
    expect(() =>
      new TenderlyVNet(base).sendTransaction(runtimeWithSecret(KEY_SECRET, ''), tx),
    ).toThrow(/missing or empty/)
    expect(calls).toHaveLength(0)
  })
})
