/** Selector for the standard `Error(string)` revert. */
const ERROR_STRING_SELECTOR = '0x08c379a0'
/** Selector for `Panic(uint256)`, emitted by Solidity's internal assertions. */
const PANIC_SELECTOR = '0x4e487b71'

const PANIC_REASONS: Record<string, string> = {
  '00': 'generic compiler panic',
  '01': 'assertion failed',
  '11': 'arithmetic overflow or underflow',
  '12': 'division or modulo by zero',
  '21': 'invalid value cast to enum',
  '22': 'malformed storage byte array',
  '31': 'pop on empty array',
  '32': 'array index out of bounds',
  '41': 'excessive memory allocation',
  '51': 'call to a zero-initialised function pointer',
}

const hexToBytes = (hex: string): number[] => {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  const out: number[] = []
  for (let i = 0; i + 1 < body.length; i += 2) {
    out.push(Number.parseInt(body.slice(i, i + 2), 16))
  }
  return out
}

const readUint = (bytes: number[], offset: number): number => {
  let value = 0
  for (let i = offset; i < offset + 32 && i < bytes.length; i += 1) {
    value = value * 256 + (bytes[i] ?? 0)
    // Values this large are never valid ABI offsets or lengths for revert data.
    if (value > Number.MAX_SAFE_INTEGER) return Number.NaN
  }
  return value
}

/**
 * Decode EVM revert data into something a human can read.
 *
 * Handles `Error(string)` and `Panic(uint256)`. A custom error is reported by
 * its 4-byte selector, since decoding it would require the ABI, which a generic
 * library does not have. Returns '' when there is nothing to decode.
 */
export const decodeRevertReason = (data: string | undefined): string => {
  if (!data || data === '0x' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) return ''

  const selector = data.slice(0, 10).toLowerCase()

  if (selector === ERROR_STRING_SELECTOR) {
    const bytes = hexToBytes(data.slice(10))
    const offset = readUint(bytes, 0)
    if (!Number.isSafeInteger(offset) || offset + 32 > bytes.length) return ''
    const length = readUint(bytes, offset)
    if (!Number.isSafeInteger(length) || offset + 32 + length > bytes.length) return ''
    const chars = bytes.slice(offset + 32, offset + 32 + length)
    return new TextDecoder().decode(new Uint8Array(chars))
  }

  if (selector === PANIC_SELECTOR) {
    const bytes = hexToBytes(data.slice(10))
    const code = (bytes[31] ?? 0).toString(16).padStart(2, '0')
    const reason = PANIC_REASONS[code]
    return reason ? `panic: ${reason} (0x${code})` : `panic: 0x${code}`
  }

  return `custom error ${selector}`
}

/**
 * True when a JSON-RPC error describes an EVM revert rather than a transport,
 * auth, or node-level problem. Those need to be told apart: a revert is a
 * *result*, while a transport failure means we learned nothing.
 */
export const isRevertError = (message: string, data: string | undefined): boolean => {
  if (data && data !== '0x') return true
  return /execution reverted|revert/i.test(message)
}
