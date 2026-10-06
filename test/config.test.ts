import { describe, expect, it } from 'bun:test'
import {
  TenderlyPreflight,
  httpActionCost,
  tenderlyConfigSchema,
  transactionSchema,
} from '../src/index.js'

const base = {
  accountSlug: 'acct',
  projectSlug: 'proj',
  accessKeySecretId: 'tenderlyaccesskey',
  fork: { networkId: '11155111', at: '6000000' },
}

describe('config', () => {
  it('applies defaults so a minimal config is complete', () => {
    const parsed = tenderlyConfigSchema.parse(base)
    expect(parsed.displayName).toBe('cre-preflight')
    expect(parsed.explainReverts).toBeTrue()
  })

  it('keeps every knob in config rather than in library source', () => {
    const parsed = tenderlyConfigSchema.parse({
      ...base,
      displayName: 'my-preflight',
      region: 'eu',
    })
    expect(parsed.displayName).toBe('my-preflight')
    expect(parsed.region).toBe('eu')
  })

  it('rejects a fork block that is not pinned', () => {
    expect(() =>
      tenderlyConfigSchema.parse({ ...base, fork: { networkId: '1', at: 'not-a-block' } }),
    ).toThrow()
  })

  it('rejects a malformed address', () => {
    expect(() => transactionSchema.parse({ from: '0x1234', to: `0x${'2'.repeat(40)}` })).toThrow()
  })

  it('rejects odd-length calldata', () => {
    expect(() =>
      transactionSchema.parse({ from: `0x${'1'.repeat(40)}`, to: `0x${'2'.repeat(40)}`, data: '0x1' }),
    ).toThrow()
  })

  it('defaults value and data on a transaction', () => {
    const parsed = transactionSchema.parse({ from: `0x${'1'.repeat(40)}`, to: `0x${'2'.repeat(40)}` })
    expect(parsed.data).toBe('0x')
    expect(parsed.value).toBe('0x0')
  })
})

describe('HTTP action budget', () => {
  it('costs five with revert explanation on', () => {
    // create + send + receipt + explain + delete
    expect(httpActionCost(tenderlyConfigSchema.parse(base))).toBe(5)
  })

  it('costs four when revert explanation is off', () => {
    expect(httpActionCost(tenderlyConfigSchema.parse({ ...base, explainReverts: false }))).toBe(4)
  })

  it('reports the per-instance cost before any per-call funding', () => {
    expect(new TenderlyPreflight(base).httpActionCost).toBe(5)
    expect(new TenderlyPreflight({ ...base, explainReverts: false }).httpActionCost).toBe(4)
    expect(new TenderlyPreflight({ ...base, deleteEnvironment: false }).httpActionCost).toBe(4)
  })
})

describe('strict config', () => {
  it('rejects a misspelled key instead of silently keeping the default', () => {
    // `deleteEnviroment` and `explainRevert` would otherwise be dropped, and the
    // operator's change would quietly have no effect.
    expect(() => tenderlyConfigSchema.parse({ ...base, deleteEnviroment: false })).toThrow()
    expect(() => tenderlyConfigSchema.parse({ ...base, explainRevert: false })).toThrow()
  })

  it('rejects an unknown key inside fork', () => {
    expect(() =>
      tenderlyConfigSchema.parse({ ...base, fork: { ...base.fork, blockNumber: '1' } }),
    ).toThrow()
  })

  it('rejects transaction fields it does not support rather than dropping them', () => {
    const from = '0x1111111111111111111111111111111111111111'
    const to = '0x2222222222222222222222222222222222222222'
    // Calldata under `input` would otherwise be dropped and `data` default to
    // 0x, so an empty call would be simulated in place of the real one.
    expect(() => transactionSchema.parse({ from, to, input: '0xdeadbeef' })).toThrow()
    expect(() => transactionSchema.parse({ from, to, nonce: '0x1' })).toThrow()
    expect(() => transactionSchema.parse({ from, to, gasPrice: '0x1' })).toThrow()
  })

  it('rejects a value that does not fit in 256 bits', () => {
    const from = '0x1111111111111111111111111111111111111111'
    const to = '0x2222222222222222222222222222222222222222'
    expect(transactionSchema.safeParse({ from, to, value: `0x${'f'.repeat(64)}` }).success).toBeTrue()
    expect(transactionSchema.safeParse({ from, to, value: `0x1${'0'.repeat(64)}` }).success).toBeFalse()
  })
})
