import { ConsensusAggregationByFields, identical, median } from '@chainlink/cre-sdk'

/**
 * `success`       the transaction executed without reverting
 * `reverted`      the transaction executed and reverted
 * `rejected`      the node refused the transaction before executing it, most often
 *                 because the sender cannot afford the gas. A real answer, not a
 *                 fault: the transaction would fail if you sent it
 * `misconfigured` Tenderly rejected the request itself: an unsupported network,
 *                 a project that does not exist, an access key without
 *                 permission. Permanent until the config or secret is fixed,
 *                 so retrying is pointless
 * `unavailable`   the nodes agreed that Tenderly could not be reached or answered
 * `oversized`     a response exceeded the HTTP capability's size limit, so the
 *                 transaction could not be inspected. Distinct from
 *                 `unavailable`: nothing is wrong with Tenderly, the
 *                 transaction is simply too complex to report on this way
 * `indeterminate` the nodes did not agree, so no verdict can be trusted
 *
 * `unavailable` and `indeterminate` are deliberately distinct. Collapsing them
 * hides the difference between "Tenderly told us it is down" and "our own nodes
 * disagreed", which are very different signals for a workflow deciding whether
 * to write on-chain.
 */
export type TransactionOutcome =
  | 'success'
  | 'reverted'
  | 'rejected'
  | 'misconfigured'
  | 'unavailable'
  | 'oversized'
  | 'indeterminate'

/**
 * The result of sending a transaction on a fork, after DON consensus.
 *
 * INVARIANT: every field here is aggregated below, and none with `ignore()`.
 *
 * `ConsensusAggregationByFields` only forwards fields that carry an aggregation
 * descriptor. `ignore()` produces a field without one, and the host silently
 * DROPS it from the aggregated object, so a type declaring `ignore`d fields
 * lies: the field is typed `string` and is `undefined` at runtime, with no
 * error at the call site. This library never calls `ignore()`.
 *
 * The consequence is that a value which is not identical on every node cannot
 * be returned at all. Each node builds its own Virtual Environment, so the
 * environment id and its dashboard link differ per node; those go to the node
 * log, which surfaces in the CRE dashboard's Logs tab, and never here.
 */
export interface TransactionVerdict {
  outcome: TransactionOutcome
  /** True only for `reverted`. False for `success` and for both failure modes. */
  reverted: boolean
  /**
   * Why the transaction did not succeed: a decoded revert reason for
   * `reverted`, the node's own words for `rejected`, Tenderly's own words for
   * `misconfigured`, `''` otherwise.
   */
  reason: string
  /** Gas used. 0n when unknown. */
  gasUsed: bigint
}

/** Field names of {@link TransactionVerdict}, for the key-parity regression test. */
export const VERDICT_FIELDS = [
  'outcome',
  'reverted',
  'reason',
  'gasUsed',
] as const satisfies readonly (keyof TransactionVerdict)[]

export const indeterminateVerdict: TransactionVerdict = {
  outcome: 'indeterminate',
  reverted: false,
  reason: '',
  gasUsed: 0n,
}

export const unavailableVerdict = (): TransactionVerdict => ({
  outcome: 'unavailable',
  reverted: false,
  reason: '',
  gasUsed: 0n,
})

/**
 * The node refused the transaction before executing it. Distinct from
 * `unavailable` because it is an answer: send this and it fails.
 */
export const rejectedVerdict = (reason: string): TransactionVerdict => ({
  outcome: 'rejected',
  reverted: false,
  reason,
  gasUsed: 0n,
})

/**
 * Tenderly rejected the request as invalid. Distinct from `unavailable` because
 * no amount of retrying fixes it: a workflow on a cron would otherwise fail
 * every run while its operator looked at infrastructure instead of config.
 */
export const misconfiguredVerdict = (reason: string): TransactionVerdict => ({
  outcome: 'misconfigured',
  reverted: false,
  reason,
  gasUsed: 0n,
})

export const oversizedVerdict = (): TransactionVerdict => ({
  outcome: 'oversized',
  reverted: false,
  reason: '',
  gasUsed: 0n,
})

/**
 * Consensus strategy.
 *
 * `gasUsed` takes the median rather than requiring agreement. Mined blocks on a
 * Virtual Environment carry the host's wall-clock timestamp, so nodes execute the
 * transaction at slightly different `block.timestamp` values; a contract whose
 * gas depends on time would otherwise fail consensus over a harmless
 * difference. The fields that decide whether to write must still be unanimous.
 */
export const verdictConsensus = ConsensusAggregationByFields<TransactionVerdict>({
  outcome: identical,
  reverted: identical,
  reason: identical,
  gasUsed: median,
}).withDefault(indeterminateVerdict)
