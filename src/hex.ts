/** A JSON-RPC QUANTITY: minimally-encoded hex, e.g. "0x0", "0x3635c9adc5dea00000". */
export const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/

/** The largest value an EVM word, balance, or storage slot can hold. */
export const UINT256_MAX = 2n ** 256n - 1n

/** Encode a non-negative integer as a JSON-RPC QUANTITY. */
export const toHexQuantity = (value: bigint): string => {
  if (value < 0n) throw new RangeError(`cannot hex-encode a negative quantity: ${value}`)
  return `0x${value.toString(16)}`
}

/**
 * Read a quantity out of a JSON-RPC response.
 *
 * Nodes are supposed to answer in hex, but a decimal string or a plain number
 * is unambiguous, so it is accepted rather than silently read as zero. Anything
 * else is `null`: the caller decides whether a missing value is fatal.
 */
export const parseQuantity = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  }
  if (typeof value !== 'string') return null
  if (/^0x[0-9a-fA-F]+$/.test(value) || /^\d+$/.test(value)) return BigInt(value)
  return null
}
