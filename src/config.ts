import { getAllNetworks } from '@chainlink/cre-sdk'
import { z } from 'zod'
import { HEX_QUANTITY } from './hex.js'
import { RESPONSE_SIZE_LIMIT } from './http.js'

/**
 * Find the CRE network for an EVM chain id.
 *
 * chainId identifies an EVM network on its own: across all 283 EVM entries in
 * the SDK's table, no chain id appears twice. So the chain selector name and
 * whether it is a testnet are both derivable, and asking a caller to repeat the
 * same chain in three different vocabularies would only create a way to
 * contradict yourself.
 */
export const findEvmNetwork = (networkId: string) =>
  getAllNetworks().find((n) => n.chainFamily === 'evm' && n.chainId === networkId)

/**
 * The entire configuration surface of this library lives here, so every knob is
 * expressible in a workflow's `config.json` and nobody has to edit library
 * source to change behaviour. It is a plain object either way: a caller is free
 * to build it in code, or to spread config and override part of it.
 *
 * The one thing that is not a free choice is credentials. The library accepts
 * a secret *name*, never a literal value, so the consuming workflow owns the
 * value in the CRE Vault. `accessKeySecretId` is a lookup key, not a key.
 *
 * Every object here is strict. A misspelled key in `config.json` is an error,
 * not a silently ignored setting that leaves the default in force, and an
 * unsupported transaction field (`input`, `nonce`, `gasPrice`) is an error
 * rather than being dropped so that a different transaction gets simulated.
 */

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')

export const hexDataSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/, 'must be even-length hex')

/** A JSON-RPC QUANTITY: minimally-encoded hex, e.g. "0x0", "0x3635c9adc5dea00000". */
export const hexQuantitySchema = z
  .string()
  .regex(HEX_QUANTITY, 'must be minimally-encoded hex quantity')
  // Minimally encoded, so 64 digits is exactly the 256-bit ceiling.
  .max(66, 'must fit in 256 bits')

/** An unsigned integer as a decimal string. Used where values can exceed 2^53. */
export const decimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/, 'must be an unsigned decimal string')

export const slugSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a URL slug')

/**
 * Setting both `explainReverts` and `includeGasUsed` to false reduces the
 * verdict to `outcome` and `reverted`, which is the minimum a caller needs to
 * decide whether to go ahead. Both fields are optional for that reason.
 */
export const tenderlyConfigSchema = z
  .object({
    accountSlug: slugSchema,
    projectSlug: slugSchema,
    /** Name of the CRE secret holding the Tenderly access key. Never the key itself. */
    accessKeySecretId: z.string().min(1, 'secret id must not be empty'),
    displayName: z.string().min(1).max(64).default('cre-preflight'),
    region: z.enum(['eu', 'us-east']).optional(),
    fork: z
      .object({
        networkId: decimalSchema,
        /**
         * Where to fork from. Either a pinned decimal block number, or a tag
         * resolved once per execution.
         *
         * A node must never resolve a tag for itself: each one would see a
         * different chain head and the forks would diverge. Instead the library
         * resolves the tag in DON mode with `evmClient.headerByNumber`, whose
         * result is consensus-verified, and hands the single agreed number to
         * every node. That read counts against `ChainRead.CallLimit`, not the
         * HTTP action budget.
         *
         * Prefer `latest`. On Sepolia, `finalized` measured ~84 blocks (about 17
         * minutes) behind the head, so a pre-flight against it judges the
         * transaction on materially stale state. Use `finalized` only when the
         * answer has to survive a reorg.
         *
         * Both are equally safe for consensus: the tag is resolved once in DON
         * mode, so every node receives the same block either way.
         */
        at: z.union([z.literal('finalized'), z.literal('latest'), decimalSchema]),
      })
      .strict()
      .superRefine((fork, ctx) => {
        // Resolving a tag needs a chain selector, which we derive from
        // networkId. Catch an unknown chain here rather than at execution time.
        const isTag = fork.at === 'finalized' || fork.at === 'latest'
        if (isTag && !findEvmNetwork(fork.networkId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['networkId'],
            message: `CRE does not know an EVM chain with id ${fork.networkId}`,
          })
        }
      }),
    /**
     * When the receipt reports a revert, spend one more HTTP action replaying the
     * call at the parent block to recover the reason.
     *
     * A receipt says *whether* a transaction reverted, never *why*. It is only
     * spent on the revert path, but must be affordable in the worst case, so it
     * is what takes the flow from four HTTP actions to five.
     *
     * It does not affect a `rejected` outcome: the node hands back its own reason
     * when it refuses a transaction, so that one costs nothing.
     */
    explainReverts: z.boolean().default(true),
    /**
     * Report the gas the transaction consumed.
     *
     * Free to collect — it comes from the receipt this flow already reads — so
     * this exists to control the *shape of the answer*, not cost. Turn it off if
     * you only care whether the transaction would succeed.
     *
     * When off, `gasUsed` is `0n` rather than absent: a field cannot be
     * conditionally present, because consensus aggregation is declared over every
     * key of the verdict type.
     */
    includeGasUsed: z.boolean().default(true),
    /**
     * Delete each node's Virtual Environment when the transaction finishes.
     *
     * On by default, and you should want it on. Every node in the DON builds its
     * own environment, so one execution of a ten-node workflow creates ten. A
     * workflow on a two-minute cron that keeps them produces about 7,200 a day.
     *
     * Turn it off only to inspect what happened, and expect to clean up by hand.
     * The environment id of each node's fork is logged either way, so a retained
     * environment can be found in the Tenderly dashboard afterwards. Keeping them
     * also makes the flow one HTTP action cheaper, which is a side effect rather
     * than a reason.
     */
    deleteEnvironment: z.boolean().default(true),
    /**
     * Bytes at or above which a JSON-RPC response is treated as unusable,
     * reported as the `oversized` outcome rather than allowed to masquerade as a
     * failure.
     *
     * Defaults to `PerWorkflow.HTTPAction.ResponseSizeLimit`. Lower it if you
     * want to fail earlier than the platform would. It does not apply to the
     * environment creation and deletion calls: those are small and fixed in
     * shape, and refusing to read the creation response would leave an
     * environment behind that nothing knows to delete.
     */
    maxResponseBytes: z.number().int().positive().max(RESPONSE_SIZE_LIMIT).default(RESPONSE_SIZE_LIMIT),
  })
  .strict()

export const transactionSchema = z
  .object({
    from: addressSchema,
    to: addressSchema,
    data: hexDataSchema.default('0x'),
    value: hexQuantitySchema.default('0x0'),
    /** Gas limit as a decimal string. Omit to let the node choose. */
    gas: decimalSchema.optional(),
  })
  .strict()

export type TenderlyConfig = z.input<typeof tenderlyConfigSchema>
export type ResolvedTenderlyConfig = z.output<typeof tenderlyConfigSchema>
export type TransactionInput = z.input<typeof transactionSchema>
export type ResolvedTransaction = z.output<typeof transactionSchema>
