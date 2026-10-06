import { describe, expect } from 'bun:test'
import { bigintToProtoBigInt, getNetwork } from '@chainlink/cre-sdk'
import { EvmMock, test as creTest } from '@chainlink/cre-sdk/test'
import { TenderlyVNet, resolveForkBlock, tenderlyConfigSchema } from '../src/index.js'
import { environmentResponse, jsonBody, mockHttp, rpcResult, runtimeWithSecret } from './helpers.js'

const CHAIN = 'ethereum-testnet-sepolia'
const SELECTOR = getNetwork({ chainFamily: 'evm', chainSelectorName: CHAIN, isTestnet: true })!
  .chainSelector.selector

const TX_HASH = `0x${'ab'.repeat(32)}`
const FROM = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'

const mockHeader = (blockNumber: bigint) => {
  const evm = EvmMock.testInstance(SELECTOR)
  const seen: unknown[] = []
  evm.headerByNumber = (input) => {
    seen.push(input.blockNumber)
    return { header: { blockNumber: bigintToProtoBigInt(blockNumber), timestamp: '1790000000' } }
  }
  return seen
}

const tagFork = (at: 'finalized' | 'latest') =>
  tenderlyConfigSchema.parse({
    accountSlug: 'acct',
    projectSlug: 'proj',
    accessKeySecretId: 'tenderlyaccesskey',
    fork: { networkId: '11155111', at },
  }).fork

describe('resolveForkBlock', () => {
  creTest('returns a pinned block without any chain read', () => {
    const seen = mockHeader(9_999_999n)
    const fork = tenderlyConfigSchema.parse({
      accountSlug: 'acct',
      projectSlug: 'proj',
      accessKeySecretId: 'tenderlyaccesskey',
      fork: { networkId: '11155111', at: '6000000' },
    }).fork

    expect(resolveForkBlock(runtimeWithSecret('x', 'y'), fork)).toBe(6_000_000n)
    expect(seen).toHaveLength(0)
  })

  creTest('resolves the finalized tag through a consensus-verified read', () => {
    const seen = mockHeader(8_123_456n)
    expect(resolveForkBlock(runtimeWithSecret('x', 'y'), tagFork('finalized'))).toBe(8_123_456n)
    expect(seen).toHaveLength(1)
  })

  creTest('resolves the latest tag', () => {
    const seen = mockHeader(8_222_222n)
    expect(resolveForkBlock(runtimeWithSecret('x', 'y'), tagFork('latest'))).toBe(8_222_222n)
    expect(seen).toHaveLength(1)
  })

  creTest('asks for a different block tag for finalized than for latest', () => {
    const finalizedSeen = mockHeader(1n)
    resolveForkBlock(runtimeWithSecret('x', 'y'), tagFork('finalized'))
    const latestSeen = mockHeader(1n)
    resolveForkBlock(runtimeWithSecret('x', 'y'), tagFork('latest'))
    const show = (v: unknown) =>
      JSON.stringify(v, (_k, value) => (typeof value === 'bigint' ? value.toString() : value))
    expect(show(finalizedSeen)).not.toBe(show(latestSeen))
  })

  creTest('still guards at run time if an unknown chain reaches it', () => {
    // The schema already rejects this, so the only way here is a caller that
    // skipped validation. Defence in depth, not the primary check.
    mockHeader(1n)
    const fork = { networkId: '424242424242', at: 'finalized' as const }
    expect(() => resolveForkBlock(runtimeWithSecret('x', 'y'), fork)).toThrow(
      /does not know an EVM chain/,
    )
  })
})

describe('config validation for fork tags', () => {
  creTest('rejects a tag on a chain CRE does not know', () => {
    expect(() =>
      tenderlyConfigSchema.parse({
        accountSlug: 'acct',
        projectSlug: 'proj',
        accessKeySecretId: 'tenderlyaccesskey',
        fork: { networkId: '424242424242', at: 'finalized' },
      }),
    ).toThrow(/does not know an EVM chain/)
  })

  creTest('rejects a block value that is neither a tag nor a number', () => {
    expect(() =>
      tenderlyConfigSchema.parse({
        accountSlug: 'acct',
        projectSlug: 'proj',
        accessKeySecretId: 'tenderlyaccesskey',
        fork: { networkId: '11155111', at: 'yesterday' },
      }),
    ).toThrow()
  })
})

describe('sendTransaction fork selection', () => {
  const dispatch = (calls: { forkBlock?: string }) => (call: { method: string; url: string; body: Record<string, unknown> | null }) => {
    if (call.method === 'DELETE') return { statusCode: 204 }
    if (call.url.endsWith('/environments')) {
      const nc = (call.body?.network_configs as Record<string, unknown>[])[0]
      calls.forkBlock = nc?.block_number as string
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
      blockNumber: '0x1',
    })
  }

  creTest('forks at the block resolved from the tag', () => {
    mockHeader(7_654_321n)
    const seen: { forkBlock?: string } = {}
    mockHttp(dispatch(seen))

    new TenderlyVNet({
      accountSlug: 'acct',
      projectSlug: 'proj',
      accessKeySecretId: 'tenderlyaccesskey',
      fork: { networkId: '11155111', at: 'finalized' },
    }).sendTransaction(runtimeWithSecret('tenderlyaccesskey', 'key'), { from: FROM, to: TO })

    expect(seen.forkBlock).toBe(`0x${(7_654_321n).toString(16)}`)
  })

  creTest('an explicit block overrides the tag and skips the chain read', () => {
    const headerCalls = mockHeader(7_654_321n)
    const seen: { forkBlock?: string } = {}
    mockHttp(dispatch(seen))

    new TenderlyVNet({
      accountSlug: 'acct',
      projectSlug: 'proj',
      accessKeySecretId: 'tenderlyaccesskey',
      fork: { networkId: '11155111', at: 'finalized' },
    }).sendTransaction(
      runtimeWithSecret('tenderlyaccesskey', 'key'),
      { from: FROM, to: TO },
      // e.g. the block an EVM log trigger fired on
      { forkBlockNumber: 5_000_000n },
    )

    expect(seen.forkBlock).toBe(`0x${(5_000_000n).toString(16)}`)
    expect(headerCalls).toHaveLength(0)
  })
})
