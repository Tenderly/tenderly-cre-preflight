import { describe, expect, it } from 'bun:test'
import { test as creTest } from '@chainlink/cre-sdk/test'
import { TenderlyVNet, VERDICT_FIELDS } from '../src/index.js'
import { environmentResponse, jsonBody, mockHttp, rpcResult, runtimeWithSecret } from './helpers.js'

const TX_HASH = `0x${'ab'.repeat(32)}`
const FROM = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'

/**
 * The regression guard for the failure mode that motivated this library.
 *
 * `ConsensusAggregationByFields` drops any field aggregated with `ignore()`,
 * because such a field carries no aggregation descriptor. A verdict type that
 * declares those fields compiles fine and is missing them at runtime. Asserting
 * on the returned KEY SET — not just on individual values — is what catches it.
 */
describe('verdict shape', () => {
  it('declares the same fields the type does', () => {
    const declared: string[] = [...VERDICT_FIELDS]
    expect(declared.sort()).toEqual(['gasUsed', 'outcome', 'reason', 'reverted'].sort())
  })

  creTest('every declared field survives consensus', () => {
    mockHttp((call) => {
      if (call.method === 'DELETE') return { statusCode: 204 }
      if (call.url.endsWith('/environments')) {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      const method = String(call.body?.method)
      if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
      return rpcResult({
        transactionHash: TX_HASH,
        from: FROM,
        to: TO,
        status: '0x1',
        gasUsed: '0x5208',
        blockNumber: '0x5b8d81',
      })
    })

    const verdict = new TenderlyVNet({
      accountSlug: 'acct',
      projectSlug: 'proj',
      accessKeySecretId: 'tenderlyaccesskey',
      fork: { networkId: '11155111', at: '6000000' },
    }).sendTransaction(runtimeWithSecret('tenderlyaccesskey', 'access-key'), { from: FROM, to: TO })

    // If a field were aggregated with `ignore()` it would be absent here while
    // still typed as present, so compare the runtime key set to the declaration.
    const declared: string[] = [...VERDICT_FIELDS]
    expect(Object.keys(verdict).sort()).toEqual(declared.sort())
    for (const field of VERDICT_FIELDS) {
      expect(verdict[field]).toBeDefined()
    }
  })
})
