import { describe, expect, it } from 'bun:test'
import {
  TenderlyVNet,
  httpActionCost,
  httpsUrlSchema,
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
    expect(parsed.displayName).toBe('cre-tenderly-sdk')
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

  it('can never be configured over the limit', () => {
    // With no funding to compete for the budget, the only variable is
    // explainReverts, and both settings fit.
    for (const explainReverts of [true, false]) {
      expect(new TenderlyVNet({ ...base, explainReverts }).httpActionCost)
        .toBeLessThanOrEqual(5)
    }
  })
})

describe('httpsUrlSchema', () => {
  // zod's own .url() is unusable in a CRE workflow: it calls `new URL()`, and
  // `URL` is undefined in QuickJS, so every value fails. Verified in simulation.
  it('accepts ordinary https URLs', () => {
    for (const url of [
      'https://api.tenderly.co',
      'https://api.eu.tenderly.co',
      'https://api.tenderly.co/api/public/v1',
      'https://localhost:8080',
    ]) {
      expect(httpsUrlSchema.safeParse(url).success).toBeTrue()
    }
  })

  it('rejects non-https and malformed values', () => {
    for (const url of ['http://api.tenderly.co', 'ftp://x.co', 'api.tenderly.co', 'https://', '']) {
      expect(httpsUrlSchema.safeParse(url).success).toBeFalse()
    }
  })
})
