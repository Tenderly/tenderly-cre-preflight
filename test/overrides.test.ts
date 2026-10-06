import { describe, expect } from 'bun:test'
import { test as creTest } from '@chainlink/cre-sdk/test'
import {
  TenderlyPreflight,
  buildStateOverrides,
  fundSchema,
  stateOverridesSchema,
  type TenderlyConfig,
} from '../src/index.js'
import {
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
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
const SLOT = `0x${'cd'.repeat(32)}`

const base = {
  accountSlug: 'acct',
  projectSlug: 'proj',
  accessKeySecretId: KEY_SECRET,
  fork: { networkId: '11155111', at: '6000000' },
}

const tx = { from: FROM, to: TO, data: '0x', gas: '100000' }

const dispatcher = () => (call: RecordedCall) => {
  if (call.method === 'DELETE') return { statusCode: 204 }
  if (call.url.endsWith('/environments')) {
    return { statusCode: 200, body: jsonBody(environmentResponse()) }
  }
  const method = String(call.body?.method)
  if (method === 'tenderly_setErc20Balance') return rpcResult('0x00')
  if (method === 'tenderly_sendTransaction') return rpcResult(TX_HASH)
  if (method === 'eth_getTransactionReceipt') {
    return rpcResult({
      transactionHash: TX_HASH,
      from: FROM,
      to: TO,
      status: '0x1',
      gasUsed: '0x5208',
      blockNumber: '0x5b8d81',
    })
  }
  return { statusCode: 500, body: '' }
}

const run = (options: Parameters<TenderlyPreflight['sendTransaction']>[2], config: TenderlyConfig = base) =>
  new TenderlyPreflight(config).sendTransaction(runtimeWithSecret(KEY_SECRET, 'access-key'), tx, options)

const sendParams = (calls: RecordedCall[]) =>
  calls.find((c) => c.body?.method === 'tenderly_sendTransaction')?.body?.params as unknown[]

describe('native funding', () => {
  creTest('rides along as a state override and costs no extra call', () => {
    const calls = mockHttp(dispatcher())
    const verdict = run({ fund: [{ addresses: [ALICE, BOB], balance: 10n ** 18n }] })

    expect(verdict.outcome).toBe('success')
    // Still four actions: funding did not buy itself a round trip.
    expect(calls.map((c) => c.body?.method ?? c.method)).toEqual([
      'POST',
      'tenderly_sendTransaction',
      'eth_getTransactionReceipt',
      'DELETE',
    ])
    expect(sendParams(calls)[1]).toEqual({
      [ALICE]: { balance: '0xde0b6b3a7640000' },
      [BOB]: { balance: '0xde0b6b3a7640000' },
    })
  })

  creTest('omits the override parameter entirely when there is nothing to override', () => {
    const calls = mockHttp(dispatcher())
    run({})
    expect(sendParams(calls)).toHaveLength(1)
  })
})

describe('erc20 funding', () => {
  creTest('spends one action per entry and funds every holder at once', () => {
    const calls = mockHttp(dispatcher())
    const verdict = run({ fund: [{ token: DAI, holders: [ALICE, BOB], balance: 100n }] })

    expect(verdict.outcome).toBe('success')
    expect(calls.map((c) => c.body?.method ?? c.method)).toEqual([
      'POST',
      'tenderly_setErc20Balance',
      'tenderly_sendTransaction',
      'eth_getTransactionReceipt',
      'DELETE',
    ])
    const funding = calls.find((c) => c.body?.method === 'tenderly_setErc20Balance')
    expect(funding?.body?.params).toEqual([DAI, [ALICE, BOB], '0x64'])
    // It is not also smuggled into the send overrides.
    expect(sendParams(calls)).toHaveLength(1)
  })

  creTest('does not second-guess the tenant quota: a large fund list still runs', () => {
    // HTTP quotas may differ between CRE tenants, so the library reports its cost
    // and lets the platform be the authority on what is affordable.
    const calls = mockHttp(dispatcher())
    const fund = Array.from({ length: 12 }, (_, i) => ({
      token: DAI,
      holders: [ALICE],
      balance: BigInt(i + 1),
    }))
    expect(run({ fund }).outcome).toBe('success')
    expect(calls.filter((c) => c.body?.method === 'tenderly_setErc20Balance')).toHaveLength(12)
  })
})

describe('raw state overrides', () => {
  creTest('passes storage slots through and pads short words', () => {
    const calls = mockHttp(dispatcher())
    run({ stateOverrides: { [DAI]: { stateDiff: { [SLOT]: 100n } } } })

    expect(sendParams(calls)[1]).toEqual({
      [DAI]: { stateDiff: { [SLOT]: `0x${'0'.repeat(62)}64` } },
    })
  })

  creTest('an explicit override wins over a fund entry for the same account', () => {
    const calls = mockHttp(dispatcher())
    run({
      fund: [{ addresses: [ALICE], balance: 1n }],
      stateOverrides: { [ALICE]: { balance: 999n } },
    })

    expect(sendParams(calls)[1]).toEqual({ [ALICE]: { balance: '0x3e7' } })
  })

  creTest('rejects an unknown override key rather than silently dropping it', () => {
    expect(() => run({ stateOverrides: { [ALICE]: { balanace: 1n } } as never })).toThrow()
  })
})

describe('buildStateOverrides', () => {
  creTest('collapses two spellings of the same address into one entry', () => {
    const fund = fundSchema.parse([{ addresses: [ALICE.toUpperCase().replace('0X', '0x')], balance: 1n }])
    expect(buildStateOverrides(fund, undefined)).toEqual({ [ALICE]: { balance: '0x1' } })
  })

  creTest('is undefined when there is nothing to say', () => {
    expect(buildStateOverrides([], undefined)).toBeUndefined()
  })

  creTest('merges storage slots from two spellings of the same address', () => {
    const checksummed = ALICE.replace(/a/g, 'A')
    const overrides = stateOverridesSchema.parse({
      [ALICE]: { stateDiff: { '0x1': 1n } },
      [checksummed]: { balance: 5n, stateDiff: { '0x2': 2n } },
    })
    const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
    expect(buildStateOverrides([], overrides)).toEqual({
      [ALICE]: { balance: '0x5', stateDiff: { [word(1)]: word(1), [word(2)]: word(2) } },
    })
  })
})

describe('256-bit bounds', () => {
  creTest('accepts the largest word and rejects anything wider', () => {
    const max = 2n ** 256n - 1n
    expect(stateOverridesSchema.safeParse({ [ALICE]: { stateDiff: { [SLOT]: max } } }).success).toBeTrue()
    expect(stateOverridesSchema.safeParse({ [ALICE]: { stateDiff: { [SLOT]: max + 1n } } }).success).toBeFalse()
    expect(stateOverridesSchema.safeParse({ [ALICE]: { balance: max + 1n } }).success).toBeFalse()
    expect(fundSchema.safeParse([{ addresses: [ALICE], balance: max + 1n }]).success).toBeFalse()
  })
})

describe('erc20 funding failures', () => {
  const fundingAnswers = (answer: () => { statusCode: number; body?: string }) =>
    mockHttp((call) =>
      call.body?.method === 'tenderly_setErc20Balance' ? answer() : dispatcher()(call),
    )
  const fundDai = () => run({ fund: [{ token: DAI, holders: [ALICE], balance: 1n }] })

  creTest('a refusal fails every run the same way, so it is misconfigured', () => {
    // Not a token, or a token whose balance slot Tenderly cannot find.
    fundingAnswers(() => rpcError('could not find balance slot', undefined, -32000))
    const verdict = fundDai()
    expect(verdict.outcome).toBe('misconfigured')
    expect(verdict.reason).toContain('could not find balance slot')
  })

  creTest('a node that could not answer is unavailable', () => {
    fundingAnswers(() => rpcError('internal error', undefined, -32603))
    expect(fundDai().outcome).toBe('unavailable')
  })
})

describe('environment retention', () => {
  creTest('deletes by default', () => {
    const calls = mockHttp(dispatcher())
    run({})
    expect(calls.some((c) => c.method === 'DELETE')).toBeTrue()
  })

  creTest('keeps the environment and saves an action when switched off', () => {
    const calls = mockHttp(dispatcher())
    const verdict = run({}, { ...base, deleteEnvironment: false })

    expect(verdict.outcome).toBe('success')
    expect(calls.map((c) => c.body?.method ?? c.method)).toEqual([
      'POST',
      'tenderly_sendTransaction',
      'eth_getTransactionReceipt',
    ])
  })

  creTest('still keeps it when a middle step throws', () => {
    const calls = mockHttp((call) => {
      if (call.url.endsWith('/environments') && call.method === 'POST') {
        return { statusCode: 200, body: jsonBody(environmentResponse()) }
      }
      if (call.body?.method === 'tenderly_sendTransaction') return { statusCode: 500, body: '' }
      return { statusCode: 500, body: '' }
    })
    run({}, { ...base, deleteEnvironment: false })
    expect(calls.some((c) => c.method === 'DELETE')).toBeFalse()
  })
})
