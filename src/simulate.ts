import { SecretsError, type NodeRuntime, type Runtime } from '@chainlink/cre-sdk'
import { z } from 'zod'
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
import { parseQuantity, toHexQuantity } from './hex.js'
import { ResponseTooLargeError } from './http.js'
import { decodeRevertReason, isRevertError } from './revert.js'
import { asRecord, classifyRpcError, jsonRpc, type RpcOutcome } from './rpc.js'
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
   *
   * A native `bigint`. A log's `blockNumber` is a protobuf BigInt, so convert
   * it with `protoBigIntToBigint` from `@chainlink/cre-sdk` first.
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

const forkBlockNumberSchema = z.bigint().positive('forkBlockNumber must be a positive bigint')

/**
 * A request that can never succeed as written: a funding entry Tenderly cannot
 * apply, or a send the node cannot parse. Reported as `misconfigured`, because
 * retrying the same input on the next run will fail the same way.
 */
class RequestRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestRefusedError'
  }
}

const txObject = (tx: ResolvedTransaction): Record<string, string> => {
  const call: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data, value: tx.value }
  if (tx.gas) call.gas = toHexQuantity(BigInt(tx.gas))
  return call
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Remove credentials from anything headed for the node log or the verdict.
 *
 * The Admin RPC URL grants full control of the environment, and capability
 * errors are free text we do not control, so every message is scrubbed of it
 * and of the access key before it leaves this module.
 */
const scrubber =
  (secrets: string[]) =>
  (message: string): string =>
    secrets.reduce(
      (text, secret) => (secret ? text.split(secret).join('<redacted>') : text),
      message,
    )

/**
 * Recover a revert reason by replaying the call against the parent block.
 *
 * The transaction has already been mined, so `latest` would evaluate the state
 * left behind by the revert rather than the state it faced. `blockNumber - 1`
 * plus the state overrides the transaction was sent with reproduces the
 * conditions it actually met: the overrides are what made a funded sender
 * funded, or a stubbed contract stubbed, so leaving them out replays a
 * different transaction. ERC20 funding needs no such help: it was written to
 * the fork before the send, so the parent block already holds it.
 *
 * Best effort. The receipt has already proved the revert; failing to explain it
 * returns `''` and never turns that answer into an outage.
 */
const explainRevert = (
  runtime: NodeRuntime<unknown>,
  rpcUrl: string,
  tx: ResolvedTransaction,
  overrides: Record<string, unknown> | undefined,
  blockNumber: bigint | null,
  maxResponseBytes: number,
  scrub: (message: string) => string,
): string => {
  if (blockNumber === null || blockNumber === 0n) return ''
  const params: unknown[] = [txObject(tx), toHexQuantity(blockNumber - 1n)]
  if (overrides) params.push(overrides)

  let replay: RpcOutcome
  try {
    replay = jsonRpc(runtime, rpcUrl, 'eth_call', params, maxResponseBytes)
  } catch (error) {
    runtime.log(`tenderly: could not recover the revert reason: ${scrub(describeError(error))}`)
    return ''
  }
  if (replay.ok) return ''
  if (!isRevertError(replay.error.message, replay.error.data)) return ''
  return scrub(decodeRevertReason(replay.error.data) || replay.error.message)
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
    maxResponseBytes,
  )
  if (funded.ok) return
  const message = `tenderly_setErc20Balance on ${entry.token} failed: ${funded.error.message}`
  // Tenderly answering with a refusal (not a token, no balance slot it can
  // find) fails identically on every run, so it is a config problem, not an
  // outage. Only a failure to get an answer at all is worth retrying.
  if (classifyRpcError(funded.error) === 'transient') throw new Error(message)
  throw new RequestRefusedError(message)
}

/**
 * Read a receipt's status. Only an explicit success or failure counts: a
 * receipt with no usable status proves nothing, and treating it as a revert
 * would invent an answer.
 */
const receiptSucceeded = (status: unknown): boolean => {
  if (status === true) return true
  if (status === false) return false
  const value = parseQuantity(status)
  if (value === 1n) return true
  if (value === 0n) return false
  throw new Error('receipt carries no usable status')
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
  let scrub = scrubber([accessKey])

  try {
    const environment = createEnvironment(runtime, config, accessKey, forkBlockNumber, (id) => {
      // Recorded before the response is validated, so an environment that
      // exists is cleaned up even when the rest of its response is unusable.
      environmentId = id
    })
    scrub = scrubber([accessKey, environment.adminRpcUrl])

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
      config.maxResponseBytes,
    )
    if (!sent.ok) {
      // A revert does NOT arrive here: a Virtual Environment accepts and mines a
      // reverting transaction and reports it through the receipt. A refusal at
      // this point means the node turned the transaction down before running
      // it, most often insufficient funds for gas. That is an answer, so it
      // gets its own outcome. A request the node could not parse says nothing
      // about the transaction, and neither does a node that could not answer.
      switch (classifyRpcError(sent.error)) {
        case 'refused': {
          const reason = scrub(sent.error.message)
          runtime.log(`tenderly: transaction rejected before execution: ${reason}`)
          return rejectedVerdict(reason)
        }
        case 'malformed':
          throw new RequestRefusedError(`tenderly_sendTransaction failed: ${sent.error.message}`)
        case 'transient':
          throw new Error(`tenderly_sendTransaction failed: ${sent.error.message}`)
      }
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

    const succeeded = receiptSucceeded(receipt.status)
    const gasUsed = config.includeGasUsed ? (parseQuantity(receipt.gasUsed) ?? 0n) : 0n

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
          overrides,
          parseQuantity(receipt.blockNumber),
          config.maxResponseBytes,
          scrub,
        )
      : ''

    return { outcome: 'reverted', reverted: true, reason, gasUsed }
  } catch (error) {
    // A response we could not read because of its size is a different fact from
    // Tenderly being unreachable, and an operator acts on it differently: the
    // transaction is too complex to inspect this way, not the infrastructure
    // being down. Reporting both as `unavailable` would hide that.
    if (error instanceof ResponseTooLargeError) {
      runtime.log(`tenderly: response too large to use: ${scrub(error.message)}`)
      return oversizedVerdict()
    }
    // Tenderly understood the request and refused it. Reporting an unsupported
    // network or a missing project as `unavailable` would send an operator
    // looking at infrastructure for something only a config change fixes, and a
    // workflow on a cron would retry it forever.
    if (
      (error instanceof EnvironmentRequestError && error.isPermanent) ||
      error instanceof RequestRefusedError
    ) {
      const reason = scrub(error.message)
      runtime.log(`tenderly: request rejected: ${reason}`)
      return misconfiguredVerdict(reason)
    }
    runtime.log(`tenderly: unavailable: ${scrub(describeError(error))}`)
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

export class TenderlyPreflight {
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
   *
   * Throws only for invalid arguments: a malformed transaction, funding entry,
   * override, or fork block. Everything that can go wrong at run time,
   * including an unreadable secret or an unresolvable fork tag, comes back as a
   * verdict, so a workflow can always decide by switching on `outcome`.
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
    const pinnedBlock =
      options.forkBlockNumber === undefined
        ? undefined
        : forkBlockNumberSchema.parse(options.forkBlockNumber)

    // Everything below runs in DON mode on consensus-verified inputs, so every
    // node reaches the same early verdict without needing consensus of its own.
    const secretId = this.config.accessKeySecretId
    let accessKey: string
    try {
      accessKey = runtime.getSecret({ id: secretId }).result().value
    } catch (error) {
      if (!(error instanceof SecretsError)) throw error
      runtime.log(`tenderly: ${error.message}`)
      return misconfiguredVerdict(`CRE secret '${secretId}' could not be read`)
    }
    if (!accessKey) {
      runtime.log(`tenderly: CRE secret '${secretId}' is empty`)
      return misconfiguredVerdict(`CRE secret '${secretId}' is empty`)
    }

    // Resolved here, in DON mode, so all nodes fork at one agreed height.
    let forkBlockNumber: bigint
    try {
      forkBlockNumber = pinnedBlock ?? resolveForkBlock(runtime, this.config.fork)
    } catch (error) {
      runtime.log(`tenderly: unavailable: could not resolve the fork block: ${describeError(error)}`)
      return unavailableVerdict()
    }

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
