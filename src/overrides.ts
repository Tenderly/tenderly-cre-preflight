import { z } from 'zod'
import { addressSchema, hexDataSchema, hexQuantitySchema } from './config.js'
import { UINT256_MAX, toHexQuantity } from './hex.js'

const uint256Schema = z
  .bigint()
  .nonnegative()
  .max(UINT256_MAX, 'must fit in 256 bits')

/**
 * A value that can be written as a JSON-RPC QUANTITY.
 *
 * `bigint` is accepted because options are built in workflow code, where
 * `parseEther('10')` is the natural way to say a balance, and forcing the
 * caller to hex-encode it by hand is a good way to get it wrong. A
 * minimally-encoded hex string is accepted too, so a value read from config
 * passes through unchanged.
 */
export const quantitySchema = z
  .union([uint256Schema, hexQuantitySchema])
  .transform((value) => (typeof value === 'bigint' ? toHexQuantity(value) : value))

/**
 * A 32-byte EVM word, used for both storage slots and the values written into
 * them.
 *
 * Also accepts a `bigint` and left-pads it. Hand-padding to 32 bytes is the
 * single most common way to write a storage override that silently targets the
 * wrong slot, so the library does it.
 */
export const wordSchema = z
  .union([
    uint256Schema,
    z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'must be hex, at most 32 bytes'),
  ])
  .transform((value) => {
    const hex = typeof value === 'bigint' ? value.toString(16) : value.slice(2)
    return `0x${hex.padStart(64, '0')}`
  })

/**
 * An override applied to one account for the duration of the send.
 *
 * `stateDiff` merges individual slots into the account's existing storage,
 * which is almost always what you want. Replacing storage wholesale is not
 * exposed: it is rarely the intent and silently zeroes everything unmentioned.
 */
export const accountOverrideSchema = z
  .object({
    balance: quantitySchema.optional(),
    nonce: quantitySchema.optional(),
    code: hexDataSchema.optional(),
    stateDiff: z.record(wordSchema, wordSchema).optional(),
  })
  .strict()

export const stateOverridesSchema = z.record(addressSchema, accountOverrideSchema)

/**
 * Give these addresses a native balance.
 *
 * Free. It rides along as a state override on the send itself rather than
 * costing its own HTTP action, which is why `tenderly_sendTransaction` is worth
 * preferring over `eth_sendTransaction`.
 */
export const nativeFundSchema = z
  .object({
    addresses: z.array(addressSchema).min(1),
    balance: quantitySchema,
  })
  .strict()

/**
 * Give these holders a balance of an ERC20.
 *
 * Costs one HTTP action per entry, because it goes through
 * `tenderly_setErc20Balance`. That call knows where a token keeps its balance
 * mapping; a raw `stateDiff` would make the caller work out the slot, which
 * breaks on proxies, packed slots and Vyper layouts. Use `stateOverrides`
 * directly when you already know the slot and want it for free.
 *
 * One entry funds any number of holders at the same balance: the underlying
 * method takes an array.
 */
export const erc20FundSchema = z
  .object({
    token: addressSchema,
    holders: z.array(addressSchema).min(1),
    balance: quantitySchema,
  })
  .strict()

export const fundSchema = z.array(z.union([nativeFundSchema, erc20FundSchema]))

export type StateOverrides = z.input<typeof stateOverridesSchema>
export type ResolvedStateOverrides = z.output<typeof stateOverridesSchema>
export type FundEntry = z.input<typeof fundSchema>[number]
export type ResolvedFundEntry = z.output<typeof fundSchema>[number]

export const isErc20Entry = (
  entry: ResolvedFundEntry,
): entry is z.output<typeof erc20FundSchema> => 'token' in entry

/** How many HTTP actions a fund list costs. Native entries are free. */
export const fundHttpActionCost = (fund: ResolvedFundEntry[]): number =>
  fund.filter(isErc20Entry).length

type AccountOverride = z.output<typeof accountOverrideSchema>

/**
 * Fold native funding into the explicit overrides, producing the state override
 * set the transaction runs against: the second parameter of
 * `tenderly_sendTransaction`, and the third of the `eth_call` that replays it.
 *
 * Addresses are lower-cased so that two spellings of the same account collapse
 * to one entry. Their `stateDiff` slots are merged rather than replaced, so no
 * slot the caller asked for is lost to a difference in checksum casing.
 *
 * An explicit `stateOverrides` entry wins over a `fund` entry for the same
 * account: it is the lower-level surface, and the caller reaching for it is
 * being more specific on purpose.
 */
export const buildStateOverrides = (
  fund: ResolvedFundEntry[],
  explicit: ResolvedStateOverrides | undefined,
): Record<string, AccountOverride> | undefined => {
  const merged: Record<string, AccountOverride> = {}

  for (const entry of fund) {
    if (isErc20Entry(entry)) continue
    for (const address of entry.addresses) {
      const key = address.toLowerCase()
      merged[key] = { ...merged[key], balance: entry.balance }
    }
  }

  for (const [address, override] of Object.entries(explicit ?? {})) {
    const key = address.toLowerCase()
    const existing = merged[key]
    const stateDiff =
      existing?.stateDiff || override.stateDiff
        ? { ...existing?.stateDiff, ...override.stateDiff }
        : undefined
    merged[key] = { ...existing, ...override, ...(stateDiff ? { stateDiff } : {}) }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}
