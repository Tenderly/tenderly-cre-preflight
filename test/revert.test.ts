import { describe, expect, it } from 'bun:test'
import { decodeRevertReason, isRevertError } from '../src/index.js'
import { errorString } from './helpers.js'


describe('decodeRevertReason', () => {
  it('decodes Error(string)', () => {
    expect(decodeRevertReason(errorString('ERC20: insufficient allowance'))).toBe(
      'ERC20: insufficient allowance',
    )
  })

  it('decodes a reason spanning more than one word', () => {
    const long = 'this revert reason is longer than thirty-two bytes on purpose'
    expect(decodeRevertReason(errorString(long))).toBe(long)
  })

  it('decodes Panic(uint256)', () => {
    const panic = `0x4e487b71${'0'.repeat(63)}1`
    expect(decodeRevertReason(panic)).toBe('panic: assertion failed (0x01)')
  })

  it('decodes an arithmetic panic', () => {
    const panic = `0x4e487b71${'0'.repeat(62)}11`
    expect(decodeRevertReason(panic)).toBe('panic: arithmetic overflow or underflow (0x11)')
  })

  it('reads the whole panic code, not just its last byte', () => {
    // Panic(0x101) is not an assertion failure, whatever its last byte says.
    expect(decodeRevertReason(`0x4e487b71${(0x101).toString(16).padStart(64, '0')}`)).toBe(
      'panic: 0x101',
    )
  })

  it('decodes nothing from a truncated panic', () => {
    expect(decodeRevertReason('0x4e487b710000000000000000000000000000000000000000000000000000000000')).toBe('')
  })

  it('reports a custom error by selector', () => {
    expect(decodeRevertReason('0xdeadbeef')).toBe('custom error 0xdeadbeef')
  })

  it('returns empty for no data', () => {
    expect(decodeRevertReason(undefined)).toBe('')
    expect(decodeRevertReason('0x')).toBe('')
    expect(decodeRevertReason('not hex')).toBe('')
  })

  it('does not throw on truncated Error(string) data', () => {
    expect(decodeRevertReason('0x08c379a000')).toBe('')
  })
})

describe('isRevertError', () => {
  it('treats revert data as a revert', () => {
    expect(isRevertError('execution reverted', '0x08c379a0')).toBeTrue()
  })

  it('treats a bare reverted message as a revert', () => {
    expect(isRevertError('execution reverted', '0x')).toBeTrue()
  })

  it('does not treat transport failures as reverts', () => {
    expect(isRevertError('HTTP 503', undefined)).toBeFalse()
    expect(isRevertError('insufficient funds for gas * price + value', undefined)).toBeFalse()
  })
})
