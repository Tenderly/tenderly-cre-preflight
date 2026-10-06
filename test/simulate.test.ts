import { describe, expect } from 'bun:test'
import { test as creTest } from '@chainlink/cre-sdk/test'
import { TenderlyPreflight, type TenderlyConfig } from '../src/index.js'
import {
  ADMIN_RPC,
  environmentResponse,
  errorString,
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
    if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
    if (method === 'eth_getTransactionReceipt') return rpcResult(receipt('0x1'))
    if (method === 'eth_call') return rpcResult('0x')
    return { statusCode: 500, body: '' }
  }

const run = (config: TenderlyConfig = base, transaction = tx) =>
  new TenderlyPreflight(config).sendTransaction(runtimeWithSecret(KEY_SECRET, 'access-key'), transaction)

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
  creTest('refuses a config that tries to set a host', () => {
    // The access key travels in an X-Access-Key header. With no host in config
    // there is nowhere else it could be sent, and an attempt to set one is an
    // error rather than something silently ignored.
    expect(() => new TenderlyPreflight({ ...base, apiBaseUrl: 'https://evil.example.com' } as never)).toThrow()
  })

  creTest('always talks to api.tenderly.co', () => {
    const calls = mockHttp(dispatcher())
    run()

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

  creTest('reports a missing secret as misconfigured, before any HTTP action', () => {
    // A missing secret is a deployment error, not a transient condition, so it
    // is `misconfigured` rather than `unavailable`. It is decided in DON mode,
    // so no environment is created and no HTTP action is spent.
    const calls = mockHttp(dispatcher())
    const verdict = new TenderlyPreflight(base).sendTransaction(
      runtimeWithSecret('someothersecret', 'k'),
      tx,
    )
    expect(verdict.outcome).toBe('misconfigured')
    expect(verdict.reason).toContain(KEY_SECRET)
    expect(calls).toHaveLength(0)
  })

  creTest('reports an empty secret as misconfigured too', () => {
    const calls = mockHttp(dispatcher())
    const verdict = new TenderlyPreflight(base).sendTransaction(runtimeWithSecret(KEY_SECRET, ''), tx)
    expect(verdict.outcome).toBe('misconfigured')
    expect(calls).toHaveLength(0)
  })
})

/** A dispatcher that lets one JSON-RPC method answer however the test needs. */
const answering =
  (method: string, answer: (call: RecordedCall) => { statusCode: number; body?: string }) =>
  (call: RecordedCall) =>
    call.body?.method === method ? answer(call) : dispatcher()(call)

describe('cleanup of environments that exist', () => {
  creTest('deletes an environment whose creation response fails validation', () => {
    // Tenderly created the environment; we refused the rest of its response.
    // The id is all cleanup needs, so the environment must still be deleted.
    const calls = mockHttp((call) => {
      if (call.method === 'POST' && call.url.endsWith('/environments')) {
        const body = environmentResponse()
        body.active_instance.vnets[0]!.rpcs = [{ url: ADMIN_RPC, name: 'Admin RPC (HTTP)' }]
        return { statusCode: 200, body: jsonBody(body) }
      }
      return dispatcher()(call)
    })

    expect(run().outcome).toBe('unavailable')
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
    expect(calls[1]?.url.endsWith('/environments/env-id-1')).toBeTrue()
  })

  creTest('a lowered maxResponseBytes does not apply to the creation response', () => {
    // The real creation body is a few KB. Holding it to a lower limit would
    // leave an environment that exists but whose id we refused to read.
    const calls = mockHttp(dispatcher())
    expect(run({ ...base, maxResponseBytes: 100 }).outcome).toBe('oversized')
    expect(calls.at(-1)?.method).toBe('DELETE')
  })
})

/**
 * Payloads as a Virtual Environment's RPC sends them: Tenderly's error code,
 * with the HTTP status that code is sent with.
 */
describe('classifying a refused send', () => {
  const sendError = (code: number, message: string, status = 200) =>
    mockHttp(answering('tenderly_sendTransaction', () => rpcError(message, undefined, code, status)))

  creTest('insufficient funds is code 3, and `rejected`', () => {
    // Every EVM-level refusal is code 3, the same as a revert.
    sendError(3, 'insufficient funds for gas * price + value')
    const verdict = run()
    expect(verdict.outcome).toBe('rejected')
    expect(verdict.reason).toBe('insufficient funds for gas * price + value')
  })

  creTest('a nonce conflict is code 3, and `rejected`', () => {
    sendError(3, 'nonce too low')
    expect(run().outcome).toBe('rejected')
  })

  creTest('a method the node does not know is `misconfigured`, not `rejected`', () => {
    sendError(-32601, 'method not found')
    expect(run().outcome).toBe('misconfigured')
  })

  creTest('invalid params are `misconfigured`, not `rejected`', () => {
    sendError(-32602, 'invalid params')
    expect(run().outcome).toBe('misconfigured')
  })

  creTest('an unsupported feature is `misconfigured`', () => {
    // Tenderly's -32002 is NotSupported, not EIP-1474's "resource unavailable".
    sendError(-32002, 'not supported')
    expect(run().outcome).toBe('misconfigured')
  })

  creTest('a BadRequest is read from its HTTP 400 body, and `misconfigured`', () => {
    sendError(-32006, 'block overrides: block number must be greater than the current block number', 400)
    expect(run().outcome).toBe('misconfigured')
  })

  creTest('a permission error is read from its HTTP 403 body, and `misconfigured`', () => {
    // Tenderly's -32003 is Unauthorized and -32004 Forbidden, not EIP-1474's
    // "transaction rejected" and "method not supported".
    sendError(-32004, 'Insufficient permissions', 403)
    expect(run().outcome).toBe('misconfigured')
  })

  for (const [code, status, message] of [
    [-32603, 200, 'internal server error'],
    [-32005, 429, 'Too many requests'],
    [-32009, 408, 'evm timeout'],
    [-32010, 200, 'Service unavailable'],
    [-32000, 200, 'state 0xabc is not available'],
    [-32098, 200, 'missing trie node'],
    [-32001, 200, 'Not found'],
  ] as const) {
    creTest(`${code} (${message}) is \`unavailable\`, not \`rejected\``, () => {
      sendError(code, message, status)
      expect(run().outcome).toBe('unavailable')
    })
  }
})

describe('retryable creation statuses', () => {
  for (const status of [408, 425, 429]) {
    creTest(`HTTP ${status} is \`unavailable\`, not \`misconfigured\``, () => {
      // A DON creating one environment per node at once is exactly the burst
      // that gets rate limited. Telling the operator to fix config is wrong.
      mockHttp((call) =>
        call.method === 'POST' && call.url.endsWith('/environments')
          ? { statusCode: status, body: jsonBody({ error: { message: 'rate limit exceeded' } }) }
          : dispatcher()(call),
      )
      expect(run().outcome).toBe('unavailable')
    })
  }
})

describe('revert explanation is best effort', () => {
  const revertedWithReplay = (replay: (call: RecordedCall) => { statusCode: number; body?: string }) =>
    mockHttp((call) =>
      call.body?.method === 'eth_call'
        ? replay(call)
        : dispatcher({ eth_getTransactionReceipt: receipt('0x0') })(call),
    )

  creTest('a replay that cannot be sent keeps the proven revert', () => {
    revertedWithReplay(() => {
      throw new Error('connection refused')
    })
    const verdict = run()
    expect(verdict.outcome).toBe('reverted')
    expect(verdict.reverted).toBeTrue()
    expect(verdict.reason).toBe('')
  })

  creTest('an oversized replay keeps the proven revert', () => {
    revertedWithReplay(() => {
      throw new Error('response buffer too small')
    })
    expect(run().outcome).toBe('reverted')
  })

  creTest('replays with the state overrides the transaction was sent with', () => {
    // A stubbed contract or a funded sender is part of the state the
    // transaction faced. Replaying without them explains a different call.
    const calls = revertedWithReplay(() => rpcError('execution reverted', errorString('stubbed')))
    const verdict = new TenderlyPreflight(base).sendTransaction(
      runtimeWithSecret(KEY_SECRET, 'access-key'),
      tx,
      {
        fund: [{ addresses: [FROM], balance: 10n ** 18n }],
        stateOverrides: { [TO]: { code: '0x6080' } },
      },
    )
    expect(verdict.reason).toBe('stubbed')

    const params = (method: string) =>
      calls.find((c) => c.body?.method === method)?.body?.params as unknown[]
    expect(params('eth_call')[2]).toEqual(params('tenderly_sendTransaction')[1])
    expect(params('eth_call')[2]).toEqual({
      [FROM]: { balance: '0xde0b6b3a7640000' },
      [TO]: { code: '0x6080' },
    })
  })
})

describe('credentials stay out of the log', () => {
  creTest('an oversized response is logged without the Admin RPC URL', () => {
    mockHttp(
      answering('eth_getTransactionReceipt', () =>
        rpcResult({ ...receipt('0x1'), logs: ['x'.repeat(300_000)] }),
      ),
    )
    const runtime = runtimeWithSecret(KEY_SECRET, 'access-key')
    expect(new TenderlyPreflight(base).sendTransaction(runtime, tx).outcome).toBe('oversized')

    const logs = runtime.getLogs().join('\n')
    expect(logs).toContain('eth_getTransactionReceipt response was')
    expect(logs).not.toContain(ADMIN_RPC)
  })

  creTest('an error message that echoes the URL or the key is scrubbed', () => {
    // Error text comes from the node and is not ours to trust. It reaches both
    // the log and the verdict's `reason`, so both must be scrubbed.
    mockHttp(
      answering('tenderly_sendTransaction', () =>
        rpcError(`nonce too low for ${ADMIN_RPC} (key access-key)`, undefined, 3),
      ),
    )
    const runtime = runtimeWithSecret(KEY_SECRET, 'access-key')
    const verdict = new TenderlyPreflight(base).sendTransaction(runtime, tx)
    expect(verdict.outcome).toBe('rejected')
    expect(verdict.reason).toBe('nonce too low for <redacted> (key <redacted>)')

    const logs = runtime.getLogs().join('\n')
    expect(logs).toContain('nonce too low')
    expect(logs).not.toContain(ADMIN_RPC)
    expect(logs).not.toContain('access-key')
  })
})

describe('receipt parsing', () => {
  creTest('a receipt with no status is `unavailable`, not `reverted`', () => {
    // Only an explicit failure proves a revert. A missing status proves nothing.
    mockHttp(
      answering('eth_getTransactionReceipt', () => rpcResult({ ...receipt('0x1'), status: null })),
    )
    expect(run().outcome).toBe('unavailable')
  })

  creTest('a zero-padded status is still read as success', () => {
    mockHttp(dispatcher({ eth_getTransactionReceipt: receipt('0x01') }))
    expect(run().outcome).toBe('success')
  })

  creTest('a decimal gasUsed is read rather than reported as zero', () => {
    mockHttp(dispatcher({ eth_getTransactionReceipt: { ...receipt('0x1'), gasUsed: '21000' } }))
    expect(run().gasUsed).toBe(21000n)
  })
})
