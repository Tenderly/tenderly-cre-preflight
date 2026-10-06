import type { NodeRuntime, Runtime } from '@chainlink/cre-sdk'
import {
  tenderlyConfigSchema,
  transactionSchema,
  type ResolvedTenderlyConfig,
  type ResolvedTransaction,
  type TenderlyConfig,
  type TransactionInput,
} from './config.js'
import { EnvironmentRequestError, createEnvironment, deleteEnvironment } from './environment.js'
import { resolveForkBlock } from './fork-block.js'
import { decodeRevertReason, isRevertError } from './revert.js'
import { asRecord, jsonRpc } from './rpc.js'
import { ResponseTooLargeError } from './http.js'
import {
  buildStateOverrides,
  fundHttpActionCost,
  fundSchema,
  isErc20Entry,
  stateOverridesSchema,
  type FundEntry,
  type ResolvedFundEntry,
  type ResolvedStateOverrides,
  type StateOverrides,
} from './overrides.js'
import {
  misconfiguredVerdict,
  oversizedVerdict,
  rejectedVerdict,
  unavailableVerdict,
  verdictConsensus,
  type TransactionVerdict,
} from './verdict.js'

interface NodeInput {
  config: ResolvedTenderlyConfig
  tx: ResolvedTransaction
  fund: ResolvedFundEntry[]
  stateOverrides: ResolvedStateOverrides | undefined
  /** Resolved in DON mode, so every node forks at the same height. */
  forkBlockNumber: bigint
  /** Resolved in DON mode: `NodeRuntime` has no secrets provider. */
  accessKey: string
}

export interface SendTransactionOptions {
  /**
   * Fork from this block instead of resolving `fork.at`.
   *
   * Use it when the workflow already knows the height it cares about — an EVM
   * log trigger payload carries the block its event was emitted in — which is
   * both cheaper and more precise than resolving a tag.
   */
  forkBlockNumber?: bigint
  /**
   * Accounts to give a balance before the transaction runs.
   *
   * Native entries are free; ERC20 entries cost one HTTP action each. See
   * {@link FundEntry}.
   */
  fund?: FundEntry[]
  /**
   * Raw account state to override for the send: balance, nonce, code, or
   * individual storage slots.
   *
   * This is the general escape hatch, and it is free — the overrides ride along
   * with the transaction rather than costing their own call. Use it when you
   * know the storage layout you want to change. For ERC20 balances where you
   * would rather not work out the slot, use `fund` instead.
   */
  stateOverrides?: StateOverrides
}

const toHexQuantity = (value: bigint | string): string =>
  `0x${(typeof value === 'bigint' ? value : BigInt(value)).toString(16)}`

const txObject = (tx: ResolvedTransaction): Record<string, string> => {
  const call: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data, value: tx.value }
  if (tx.gas) call.gas = toHexQuantity(tx.gas)
  return call
}

const toBigInt = (value: unknown): bigint =>
  typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : 0n

/**
 * Recover a revert reason by replaying the call against the parent block.
 *
 * The transaction has already been mined, so `latest` would evaluate the state
 * left behind by the revert rather than the state it faced. `blockNumber - 1`
 * reproduces the conditions the transaction actually met.
 *
 * State overrides are deliberately NOT replayed here. They are applied with the
 * transaction, so the parent block never had them, and re-applying them would
 * be reconstructing a state that never existed. Verified against a live fork:
 * a transaction funded purely by a balance override still reports its true
 * revert reason on replay, because `eth_call` does not charge the caller for
 * gas when no gasPrice is set.
 */
const explainRevert = (
  runtime: NodeRuntime<unknown>,
  rpcUrl: string,
  tx: ResolvedTransaction,
  blockNumber: bigint,
  maxResponseBytes: number,
): string => {
  if (blockNumber === 0n) return ''
  const replay = jsonRpc(
    runtime,
    rpcUrl,
    'eth_call',
    [txObject(tx), toHexQuantity(blockNumber - 1n)],
    { store: false },
    maxResponseBytes,
  )
  if (replay.ok) return ''
  if (!isRevertError(replay.error.message, replay.error.data)) return ''
  return decodeRevertReason(replay.error.data) || replay.error.message
}

/** One HTTP action per entry. Funds every holder in the entry at once. */
const applyErc20Funding = (
  runtime: NodeRuntime<unknown>,
  rpcUrl: string,
  entry: Extract<ResolvedFundEntry, { token: string }>,
  maxResponseBytes: number,
): void => {
  const funded = jsonRpc(
    runtime,
    rpcUrl,
    'tenderly_setErc20Balance',
    [entry.token, entry.holders, entry.balance],
    { store: false },
    maxResponseBytes,
  )
  if (!funded.ok) {
    throw new Error(`tenderly_setErc20Balance on ${entry.token} failed: ${funded.error.message}`)
  }
}

/**
 * Create a fork, apply funding and overrides, send the transaction, read the
 * receipt, and delete the environment.
 *
 * Every node in the DON runs this independently and therefore builds its own
 * Virtual Environment, which is why nothing environment-specific can be returned.
 */
const runSendTransaction = (runtime: NodeRuntime<unknown>, input: NodeInput): TransactionVerdict => {
  const { config, tx, fund, stateOverrides, accessKey, forkBlockNumber } = input
  let environmentId: string | null = null

  try {
    const environment = createEnvironment(runtime, config, accessKey, forkBlockNumber)
    environmentId = environment.environmentId

    // The chain id comes from the creation response. Confirming it with an
    // eth_chainId round trip would spend an HTTP action to re-learn something
    // we have already been told.
    if (environment.chainId !== Number.parseInt(config.fork.networkId, 10)) {
      throw new Error(
        `fork chain id ${environment.chainId} does not match requested ${config.fork.networkId}`,
      )
    }

    for (const entry of fund) {
      if (isErc20Entry(entry)) {
        applyErc20Funding(runtime, environment.adminRpcUrl, entry, config.maxResponseBytes)
      }
    }

    // Native balances and raw storage ride along with the send as state
    // overrides, so they cost nothing. `tenderly_sendTransaction` takes them as
    // an optional second parameter and is otherwise identical to
    // eth_sendTransaction, including giving a more specific message when it
    // refuses a transaction outright.
    const overrides = buildStateOverrides(fund, stateOverrides)
    const params: unknown[] = overrides ? [txObject(tx), overrides] : [txObject(tx)]

    const sent = jsonRpc(
      runtime,
      environment.adminRpcUrl,
      'tenderly_sendTransaction',
      params,
      { store: false },
      config.maxResponseBytes,
    )
    if (!sent.ok) {
      // A revert does NOT arrive here: a Virtual Environment accepts and mines a
      // reverting transaction and reports it through the receipt. An error from
      // the node at this point means it refused the transaction before running
      // it, most often insufficient funds for gas. That is an answer, so it
      // gets its own outcome rather than being reported as an outage.
      if (sent.error.kind === 'rpc') {
        runtime.log(`tenderly: transaction rejected before execution: ${sent.error.message}`)
        return rejectedVerdict(sent.error.message)
      }
      throw new Error(`tenderly_sendTransaction failed: ${sent.error.message}`)
    }

    const transactionHash = sent.result
    if (typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      throw new Error('virtual network returned an invalid transaction hash')
    }

    const received = jsonRpc(
      runtime,
      environment.adminRpcUrl,
      'eth_getTransactionReceipt',
      [transactionHash],
      { store: false },
      config.maxResponseBytes,
    )
    if (!received.ok) throw new Error(`eth_getTransactionReceipt failed: ${received.error.message}`)

    const receipt = asRecord(received.result)
    if (
      !receipt ||
      receipt.transactionHash !== transactionHash ||
      String(receipt.from).toLowerCase() !== tx.from.toLowerCase() ||
      String(receipt.to).toLowerCase() !== tx.to.toLowerCase()
    ) {
      throw new Error('receipt does not match the submitted transaction')
    }

    const succeeded = receipt.status === '0x1' || receipt.status === 1 || receipt.status === true
    const gasUsed = config.includeGasUsed ? toBigInt(receipt.gasUsed) : 0n

    // Per-node values. They differ on every node, so they can only be logged;
    // a field that is not identical across the DON cannot survive consensus.
    runtime.log(`tenderly: environment ${environment.environmentId} tx ${transactionHash}`)

    if (succeeded) {
      return { outcome: 'success', reverted: false, reason: '', gasUsed }
    }

    const reason = config.explainReverts
      ? explainRevert(
          runtime,
          environment.adminRpcUrl,
          tx,
          toBigInt(receipt.blockNumber),
          config.maxResponseBytes,
        )
      : ''

    return { outcome: 'reverted', reverted: true, reason, gasUsed }
  } catch (error) {
    // A response we could not read because of its size is a different fact from
    // Tenderly being unreachable, and an operator acts on it differently: the
    // transaction is too complex to inspect this way, not the infrastructure
    // being down. Reporting both as `unavailable` would hide that.
    if (error instanceof ResponseTooLargeError) {
      runtime.log(`tenderly: response too large to use: ${error.message}`)
      return oversizedVerdict()
    }
    // Tenderly understood the request and refused it. Reporting an unsupported
    // network or a missing project as `unavailable` would send an operator
    // looking at infrastructure for something only a config change fixes, and a
    // workflow on a cron would retry it forever.
    if (error instanceof EnvironmentRequestError && error.isPermanent) {
      runtime.log(`tenderly: request rejected: ${error.message}`)
      return misconfiguredVerdict(error.message)
    }
    const detail = error instanceof Error ? error.message : String(error)
    runtime.log(`tenderly: unavailable: ${detail}`)
    return unavailableVerdict()
  } finally {
    if (environmentId) {
      if (config.deleteEnvironment) {
        deleteEnvironment(runtime, config, accessKey, environmentId)
      } else {
        runtime.log(`tenderly: keeping environment ${environmentId}, delete it yourself`)
      }
    }
  }
}

/**
 * Worst-case HTTP actions per node for a given configuration and call.
 *
 * create, send, receipt, and delete when enabled, plus one on the revert path
 * when `explainReverts` is on, plus one per ERC20 funding entry. Native funding
 * and raw state overrides are free: they travel with the send.
 *
 * Reported, never enforced. HTTP quotas may differ between CRE tenants, so the
 * library does not assume a ceiling it cannot know; compare this against your
 * own `PerWorkflow.HTTPAction.CallLimit` if you are budgeting a workflow.
 */
export const httpActionCost = (
  config: ResolvedTenderlyConfig,
  fund: ResolvedFundEntry[] = [],
): number =>
  3 +
  (config.deleteEnvironment ? 1 : 0) +
  (config.explainReverts ? 1 : 0) +
  fundHttpActionCost(fund)

export class TenderlyVNet {
  private readonly config: ResolvedTenderlyConfig

  constructor(config: TenderlyConfig) {
    this.config = tenderlyConfigSchema.parse(config)
  }

  /**
   * HTTP actions this instance spends per node before any per-call funding.
   *
   * A call that passes ERC20 `fund` entries costs one more per entry.
   */
  get httpActionCost(): number {
    return httpActionCost(this.config)
  }

  /**
   * Send a transaction on a throwaway Virtual Environment and return a
   * consensus-verified verdict.
   *
   * The transaction is mined on the fork, so it sees and leaves state exactly
   * as it would on the real chain. Nothing reaches the real chain: the fork is
   * created for this call and, by default, deleted after it.
   *
   * Call this from a DON-mode callback. The access key is resolved here,
   * because `NodeRuntime` has no secrets provider — only `Runtime` does — and
   * then passed into node mode with the rest of the input.
   */
  sendTransaction<C>(
    runtime: Runtime<C>,
    transaction: TransactionInput,
    options: SendTransactionOptions = {},
  ): TransactionVerdict {
    const tx = transactionSchema.parse(transaction)
    const fund = fundSchema.parse(options.fund ?? [])
    const stateOverrides =
      options.stateOverrides === undefined
        ? undefined
        : stateOverridesSchema.parse(options.stateOverrides)

    const accessKey = runtime.getSecret({ id: this.config.accessKeySecretId }).result().value
    if (!accessKey) {
      throw new Error(`CRE secret '${this.config.accessKeySecretId}' is missing or empty`)
    }

    // Resolved here, in DON mode, so all nodes fork at one agreed height.
    const forkBlockNumber = options.forkBlockNumber ?? resolveForkBlock(runtime, this.config.fork)

    return runtime
      .runInNodeMode(runSendTransaction, verdictConsensus)({
        config: this.config,
        tx,
        fund,
        stateOverrides,
        forkBlockNumber,
        accessKey,
      })
      .result()
  }
}
