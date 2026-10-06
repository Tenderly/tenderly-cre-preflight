import { describe, expect, it } from 'bun:test'
import { HttpActionsMock, test as creTest } from '@chainlink/cre-sdk/test'
import {
  RESPONSE_SIZE_LIMIT,
  TenderlyPreflight,
  isSizeRejection,
  tenderlyConfigSchema,
} from '../src/index.js'
import { environmentResponse, jsonBody, mockHttp, rpcResult, runtimeWithSecret } from './helpers.js'

const KEY = 'tenderlyaccesskey'
const TX_HASH = `0x${'ab'.repeat(32)}`
const FROM = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'

const base = {
  accountSlug: 'acct',
  projectSlug: 'proj',
  accessKeySecretId: KEY,
  fork: { networkId: '11155111', at: '6000000' },
}

const run = (config: Parameters<typeof tenderlyConfigSchema.parse>[0] = base) =>
  new TenderlyPreflight(config as never).sendTransaction(runtimeWithSecret(KEY, 'access-key'), {
    from: FROM,
    to: TO,
  })

/** A receipt padded with synthetic logs until it crosses `bytes`. */
const fatReceipt = (bytes: number) => {
  const logs: unknown[] = []
  const receipt = () => ({
    transactionHash: TX_HASH,
    from: FROM,
    to: TO,
    status: '0x1',
    gasUsed: '0x5208',
    blockNumber: '0x5b8d81',
    logs,
  })
  while (JSON.stringify(receipt()).length < bytes) {
    logs.push({
      address: TO,
      topics: [`0x${'cd'.repeat(32)}`, `0x${'ef'.repeat(32)}`],
      data: `0x${'ab'.repeat(200)}`,
    })
  }
  return receipt()
}

describe('isSizeRejection', () => {
  it('recognises the SDK buffer message', () => {
    expect(isSizeRejection('response buffer too small')).toBeTrue()
  })

  it('recognises platform-side size wording', () => {
    expect(isSizeRejection('response body too large')).toBeTrue()
    expect(isSizeRejection('payload exceeds size limit')).toBeTrue()
  })

  it('does not mistake ordinary failures for size rejections', () => {
    expect(isSizeRejection('connection refused')).toBeFalse()
    expect(isSizeRejection('unauthorized')).toBeFalse()
    expect(isSizeRejection('execution reverted')).toBeFalse()
  })

  it('does not mistake a timeout or a call quota for a size rejection', () => {
    for (const message of [
      'response timeout exceeded',
      'response deadline exceeded',
      'body read exceeded deadline',
      'HTTP response exceeded deadline',
      'payload exceeds max call limit',
      'request timed out',
    ]) {
      expect(isSizeRejection(message)).toBeFalse()
    }
  })
})

describe('size guard', () => {
  creTest('reports an oversized receipt as `oversized`, not `unavailable`', () => {
    // This is the realistic case: a real mainnet transaction with ~100 logs
    // produces a receipt of ~110 KB, over PerWorkflow.HTTPAction.ResponseSizeLimit.
    mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      const method = String(call.body?.method)
      if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
      return rpcResult(fatReceipt(RESPONSE_SIZE_LIMIT + 5_000))
    })

    expect(run().outcome).toBe('oversized')
  })

  creTest('still deletes the environment when a response is oversized', () => {
    const calls = mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      const method = String(call.body?.method)
      if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
      return rpcResult(fatReceipt(RESPONSE_SIZE_LIMIT + 5_000))
    })

    run()
    expect(calls.at(-1)?.method).toBe('DELETE')
  })

  creTest('accepts a response comfortably under the limit', () => {
    mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      const method = String(call.body?.method)
      if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
      return rpcResult(fatReceipt(20_000))
    })

    expect(run().outcome).toBe('success')
  })

  creTest('honours a lowered maxResponseBytes', () => {
    mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      const method = String(call.body?.method)
      if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
      return rpcResult(fatReceipt(20_000))
    })

    // The same 20 KB receipt that passed above now fails against a 10 KB ceiling.
    expect(run({ ...base, maxResponseBytes: 10_000 }).outcome).toBe('oversized')
  })

  creTest('classifies a capability size rejection as oversized', () => {
    const http = HttpActionsMock.testInstance()
    http.sendRequest = (request) => {
      if (String(request.url).endsWith('/environments') && String(request.method) === 'POST') {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      // The capability refuses to hand the body back at all.
      throw new Error('response buffer too small')
    }
    expect(run().outcome).toBe('oversized')
  })

  creTest('classifies a capability timeout as unavailable, not oversized', () => {
    const http = HttpActionsMock.testInstance()
    http.sendRequest = (request) => {
      if (String(request.url).endsWith('/environments') && String(request.method) === 'POST') {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      throw new Error('http: response timeout exceeded')
    }
    expect(run().outcome).toBe('unavailable')
  })

  creTest('classifies a non-size capability error as unavailable', () => {
    const http = HttpActionsMock.testInstance()
    http.sendRequest = (request) => {
      if (String(request.url).endsWith('/environments') && String(request.method) === 'POST') {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      throw new Error('connection refused')
    }
    expect(run().outcome).toBe('unavailable')
  })
})

describe('maxResponseBytes config', () => {
  it('defaults to the platform quota', () => {
    expect(tenderlyConfigSchema.parse(base).maxResponseBytes).toBe(RESPONSE_SIZE_LIMIT)
  })

  it('cannot be raised above the platform quota', () => {
    expect(() =>
      tenderlyConfigSchema.parse({ ...base, maxResponseBytes: RESPONSE_SIZE_LIMIT + 1 }),
    ).toThrow()
  })
})
