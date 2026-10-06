import { describe, expect } from 'bun:test'
import { test as creTest } from '@chainlink/cre-sdk/test'
import { TenderlyPreflight, VERDICT_FIELDS, type TenderlyConfig } from '../src/index.js'
import {
  environmentResponse,
  errorString,
  jsonBody,
  mockHttp,
  rpcError,
  rpcResult,
  runtimeWithSecret,
} from './helpers.js'

const KEY = 'tenderlyaccesskey'
const TX = `0x${'ab'.repeat(32)}`
const FROM = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'

const base = {
  accountSlug: 'acct',
  projectSlug: 'proj',
  accessKeySecretId: KEY,
  fork: { networkId: '11155111', at: '6000000' },
}


const run = (cfg: TenderlyConfig, status = '0x1') => {
  const calls = mockHttp((call) => {
    if (call.method === 'DELETE') return { statusCode: 204 }
    if (call.url.endsWith('/environments')) return { statusCode: 200, body: jsonBody(environmentResponse()) }
    const m = String(call.body?.method)
    if (m === 'tenderly_sendTransaction') return rpcResult(TX)
    if (m === 'eth_call') return rpcError('execution reverted', errorString('ERC20: bad'))
    return rpcResult({ transactionHash: TX, from: FROM, to: TO, status, gasUsed: '0x5208', blockNumber: '0x5b8d81' })
  })
  const v = new TenderlyPreflight(cfg).sendTransaction(runtimeWithSecret(KEY, 'k'), { from: FROM, to: TO })
  return { verdict: v, calls }
}

describe('optional verdict fields', () => {
  creTest('gasUsed is reported by default', () => {
    expect(run(base).verdict.gasUsed).toBe(21000n)
  })

  creTest('includeGasUsed:false zeroes it without removing the field', () => {
    const { verdict } = run({ ...base, includeGasUsed: false })
    expect(verdict.gasUsed).toBe(0n)
    // The key must still exist: consensus is declared over every key of the
    // verdict type, so a field can never be conditionally absent.
    expect(Object.keys(verdict)).toContain('gasUsed')
    expect(Object.keys(verdict).sort()).toEqual([...VERDICT_FIELDS].map(String).sort())
  })

  creTest('explainReverts:false leaves revertReason empty and skips the call', () => {
    const { verdict, calls } = run({ ...base, explainReverts: false }, '0x0')
    expect(verdict.outcome).toBe('reverted')
    expect(verdict.reason).toBe('')
    expect(calls.some((c) => c.body?.method === 'eth_call')).toBeFalse()
  })

  creTest('both off reduces the verdict to go / no-go', () => {
    // outcome and reverted are the minimum a caller needs to decide.
    const { verdict, calls } = run(
      { ...base, explainReverts: false, includeGasUsed: false }, '0x0')
    expect(verdict.outcome).toBe('reverted')
    expect(verdict.reverted).toBeTrue()
    expect(verdict.reason).toBe('')
    expect(verdict.gasUsed).toBe(0n)
    // create, send, receipt, delete. No eth_chainId: the creation response
    // already carries the fork's chain id.
    expect(calls).toHaveLength(4)
  })

  creTest('turning gas off does not change the HTTP budget', () => {
    // It comes from the receipt this flow already reads, so it is free either way.
    expect(new TenderlyPreflight(base).httpActionCost).toBe(5)
    expect(new TenderlyPreflight({ ...base, includeGasUsed: false }).httpActionCost).toBe(5)
    expect(new TenderlyPreflight({ ...base, explainReverts: false }).httpActionCost).toBe(4)
  })
})
