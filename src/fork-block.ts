import {
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  cre,
  protoBigIntToBigint,
  type Runtime,
} from '@chainlink/cre-sdk'
import { findEvmNetwork, type ResolvedTenderlyConfig } from './config.js'

/**
 * Work out which block to fork from, as a single value every node agrees on.
 *
 * This is the whole reason a fork block cannot simply be `"latest"`. If each
 * node resolved the tag itself it would see a slightly different chain head,
 * the forks would differ, and the nodes would be simulating against different
 * state. So the tag is resolved exactly once here, in DON mode, through
 * `evmClient.headerByNumber` — a consensus-verified read — and the agreed
 * number is then handed to every node.
 *
 * A pinned number in config skips the read entirely.
 *
 * Cost: one EVM read against `PerWorkflow.ChainRead.CallLimit`. It does not
 * touch the HTTP actions the send itself needs.
 */
export const resolveForkBlock = <C>(
  runtime: Runtime<C>,
  fork: ResolvedTenderlyConfig['fork'],
): bigint => {
  if (fork.at !== 'finalized' && fork.at !== 'latest') return BigInt(fork.at)

  const network = findEvmNetwork(fork.networkId)
  if (!network) {
    throw new Error(`CRE does not know an EVM chain with id ${fork.networkId}`)
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)
  const reply = evmClient
    .headerByNumber(runtime, {
      blockNumber: fork.at === 'finalized' ? LAST_FINALIZED_BLOCK_NUMBER : LATEST_BLOCK_NUMBER,
    })
    .result()

  const header = reply.header
  if (!header?.blockNumber) {
    throw new Error(`could not resolve the ${fork.at} block on chain ${fork.networkId}`)
  }

  const blockNumber = protoBigIntToBigint(header.blockNumber)
  if (blockNumber <= 0n) {
    throw new Error(`resolved an invalid ${fork.at} block number: ${blockNumber}`)
  }

  // Logged because it is the one value that explains a verdict after the fact.
  // Every environment is deleted at the end of the execution, so without this
  // there is no record of which chain state the transaction was judged against.
  // It is resolved in DON mode, so this line is identical on every node.
  runtime.log(
    `tenderly: forking ${network.chainSelector.name} at block ${blockNumber} (${fork.at})`,
  )
  return blockNumber
}
