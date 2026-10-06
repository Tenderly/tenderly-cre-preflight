/**
 * Minimal CRE workflow: refuse to write on-chain when the write would revert.
 *
 * This file is illustrative and is not published with the package. Copy it into
 * a real CRE project (`cre init`) and point `config.json` at your own contract.
 */
import { CronCapability, handler, Runner, type Runtime } from '@chainlink/cre-sdk'
import { TenderlyPreflight, type TenderlyConfig, type TransactionInput } from '@tenderly/cre-preflight'

type Config = {
  schedule: string
  tenderly: TenderlyConfig
  transaction: TransactionInput
}

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const tenderly = new TenderlyPreflight(runtime.config.tenderly)

  // In a real workflow the transaction is built from whatever this execution
  // just worked out: a price fetched over HTTP, a report from runtime.report(),
  // a decision taken on-chain state. It is an argument rather than config
  // precisely because it changes on every run. This example keeps a fixed one
  // in config only so the workflow has something to simulate.
  const verdict = tenderly.sendTransaction(runtime, runtime.config.transaction)

  switch (verdict.outcome) {
    case 'success':
      runtime.log(`preflight passed, gas ${verdict.gasUsed}`)
      // ... runtime.report(...) and evmClient.writeReport(...) go here.
      return 'preflight passed'

    case 'reverted':
    case 'rejected':
      // A real answer: this transaction would fail on-chain. Skip it, and say why.
      runtime.log(`skipping write, would fail: ${verdict.reason}`)
      return `skipped: ${verdict.outcome}`

    case 'misconfigured':
      // The request can never succeed as written: the config, the Vault secret,
      // or the funding passed with the call. Every run fails until it is fixed.
      runtime.log(`tenderly rejected the request: ${verdict.reason}`)
      return 'skipped: misconfigured'

    case 'unavailable':
    case 'oversized':
    case 'indeterminate':
      // We learned nothing. Fail closed rather than writing blind.
      runtime.log(`skipping write, no verdict: ${verdict.outcome}`)
      return `skipped: ${verdict.outcome}`
  }
}

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCronTrigger),
]

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}

main()
