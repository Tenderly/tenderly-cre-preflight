# @tenderly/cre-preflight

Simulate an EVM transaction on a [Tenderly Virtual Environment](https://docs.tenderly.co/virtual-environments)
from inside a [Chainlink CRE](https://docs.chain.link/cre) workflow, and get a
consensus-verified verdict back.

Each node forks the chain at an agreed block, applies any funding and state
overrides you asked for, sends the transaction, and reads the receipt. The
transaction is mined on the fork, so it behaves exactly as it would on the real
chain, and nothing reaches the real chain. Use it to find out what a transaction
would do before your workflow commits to it.

```ts
const verdict = tenderly.sendTransaction(runtime, { from, to, data })

if (verdict.outcome !== 'success') {
  runtime.log(`skipping write: ${verdict.outcome} ${verdict.reason}`)
  return 'skipped'
}
```

## Install

```bash
bun add @tenderly/cre-preflight
```

`@chainlink/cre-sdk` (1.22 or newer, below 2.0) and `zod` 3 are peer
dependencies. Your workflow already has both: `@chainlink/cre-sdk` depends on
zod 3 itself. The schemas this package exports (`tenderlyConfigSchema`,
`transactionSchema`, ...) are zod 3 schemas, so if your own config schema is
written in zod 4, validate this package's slice of it separately rather than
nesting one inside the other.

You also need **Bun 1.4 or newer**. Older versions silently produce a WASM binary
that traps at handler registration with `wasm trap: unreachable` and no useful
diagnostic. The CRE installer only checks for Bun >= 1.0.0, so this is easy to
hit.

## Usage

```ts
import { TenderlyPreflight } from '@tenderly/cre-preflight'

const tenderly = new TenderlyPreflight(runtime.config.tenderly)

const verdict = tenderly.sendTransaction(runtime, {
  from: sender,
  to: contract,
  data: calldata,
})
```

Call it from a DON-mode handler. The transaction is an argument rather than
config, because it is usually built from whatever the execution just worked out.

## Configuration

`TenderlyPreflight` takes a plain object, so build it however suits you. Reading it
from `config.json` means you can change it without touching workflow code, which
is why the examples here do that, but a literal in code works just as well and
so does a mix:

```ts
new TenderlyPreflight({
  ...runtime.config.tenderly,
  fork: { networkId: '1', at: 'finalized' },
})
```

Every object is strict: a misspelled key such as `deleteEnviroment` is an error,
not a setting that is silently ignored while the default stays in force.

The one real constraint is the credential. `accessKeySecretId` is a secret
**name**, which the library resolves from the CRE Vault at call time. There is
no field that takes an access key, so the value never appears in config or in
your workflow source.

Use a Tenderly access key scoped to the one project this workflow forks in, and
nothing more. The key is read as an ordinary CRE secret, so every node in the
DON holds it in memory while the workflow runs.

```jsonc
{
  "tenderly": {
    "accountSlug": "my-account",
    "projectSlug": "my-project",
    "accessKeySecretId": "tenderlyaccesskey",
    "fork": {
      "networkId": "1",
      "at": "latest"                          // or "finalized", or a block number
    },

    // all optional, shown with their defaults
    "displayName": "cre-preflight",
    "region": "eu",                           // "us" or "eu"; omit to let Tenderly choose
    "explainReverts": true,
    "includeGasUsed": true,
    "deleteEnvironment": true,
    "maxResponseBytes": 256000
  }
}
```

| Option | Default | What it does |
|---|---|---|
| `accountSlug`, `projectSlug` | required | Where environments are created. |
| `accessKeySecretId` | required | Name of the CRE secret holding your Tenderly access key. |
| `fork.networkId` | required | Chain id as a decimal string. The chain is derived from this alone. |
| `fork.at` | required | `"latest"`, `"finalized"`, or a decimal block number. |
| `displayName` | `cre-preflight` | Name the environments appear under in Tenderly. |
| `region` | unset | `"us"` or `"eu"`. |
| `explainReverts` | `true` | Recover the revert reason. Costs one extra HTTP action, and only on the revert path. |
| `includeGasUsed` | `true` | Report gas. Free, it is already in the receipt. |
| `deleteEnvironment` | `true` | Delete each node's fork when the transaction finishes. |
| `maxResponseBytes` | `256000` | Treat a JSON-RPC response at or above this as unusable. |

## Choosing the fork block

A node must never resolve `latest` for itself, because each one would see a
different chain head and the forks would diverge. `fork.at` handles that: a tag
is resolved **once per execution**, through a consensus-verified chain read, and
every node is handed the same block number.

| `fork.at` | When to use it |
|---|---|
| `"latest"` | Normal choice. Closest to current state, and still safe. |
| `"finalized"` | When the answer must survive a reorg. On Sepolia it measured about 84 blocks behind the head, so it judges against materially older state. |
| `"6000000"` | A pinned block. No chain read at all. |

Not every chain CRE knows can be forked. If Tenderly does not support the
network, the first call fails with `misconfigured` and `reason` reads
`Unsupported network id`. The
[supported networks list](https://docs.tenderly.co/supported-networks-and-languages)
is the place to check before you deploy.

If your workflow already knows the height it cares about, pass it directly and
skip the read. It must be a native `bigint`; a log's `blockNumber` is a protobuf
BigInt, so convert it first:

```ts
import { protoBigIntToBigint } from '@chainlink/cre-sdk'

const forkBlockNumber = log.blockNumber && protoBigIntToBigint(log.blockNumber)
tenderly.sendTransaction(runtime, tx, { forkBlockNumber })
```

When `forkBlockNumber` is `undefined`, `fork.at` is used as usual.

## Funding and state overrides

Both are per-call options, because what needs funding depends on the transaction
you are simulating.

```ts
tenderly.sendTransaction(runtime, tx, {
  fund: [
    { addresses: [alice, bob], balance: parseEther('10') },
    { token: DAI, holders: [alice], balance: parseUnits('100', 18) },
  ],

  stateOverrides: {
    [DAI]: { stateDiff: { [slot]: 100n * 10n ** 18n } },
    [oracle]: { code: '0x60806040...' },
  },
})
```

**`fund`** takes a list. An entry with `addresses` sets a native balance; an
entry with `token` and `holders` sets an ERC20 balance, and funds every holder
in that entry at once.

**`stateOverrides`** sets `balance`, `nonce`, `code` or individual storage slots
directly. Reach for it when you know the layout you want to change, or when you
need something `fund` does not cover.

Balances and storage words take a `bigint` or a hex string, and a `bigint` slot
or value is left-padded to 32 bytes for you. Where both name the same account,
`stateOverrides` wins.

`parseEther` and `parseUnits` above are [viem's](https://viem.sh), not this
library's. viem is already in your tree as a dependency of `@chainlink/cre-sdk`.
Plain `bigint` literals work just as well.

Costs differ: native balances and `stateOverrides` are free, because they travel
with the transaction itself. Each ERC20 `fund` entry costs one HTTP action, in
exchange for not making you work out the token's storage slot, which breaks on
proxies, packed slots and Vyper layouts.

One thing to keep in mind: the sender's real balance is part of what a guard is
asking about. Topping the sender up turns "would this succeed if I sent it now"
into an easier question, and hides an insufficient-funds failure behind a green
light. Fund deliberately, for scenarios where the balance is not what you are
testing.

## The verdict

```ts
interface TransactionVerdict {
  outcome:
    | 'success'
    | 'reverted'
    | 'rejected'
    | 'misconfigured'
    | 'unavailable'
    | 'oversized'
    | 'indeterminate'
  reverted: boolean
  reason: string  // decoded Error(string) / Panic(uint256) / custom selector
  gasUsed: bigint
}
```

| `outcome` | Meaning |
|---|---|
| `success` | The transaction would succeed. |
| `reverted` | It executed and reverted. `reason` says why when `explainReverts` is on. |
| `rejected` | The node refused it before executing, usually insufficient funds for gas. An answer, not a fault: send it and it fails. `reason` carries the node's own words. |
| `misconfigured` | The request can never succeed as written: an unsupported network, a project that does not exist, a key without permission, a secret that cannot be read, a `fund` entry Tenderly cannot apply. `reason` says which. Retrying will not help. |
| `unavailable` | Tenderly or the chain could not be reached, answered with an error worth retrying (5xx, rate limiting), or gave an answer too incomplete to judge. Says nothing about your transaction. |
| `oversized` | A response was too large to read. The transaction is too complex to report on this way; nothing is wrong with Tenderly. |
| `indeterminate` | The nodes did not agree, so no verdict can be trusted. |

Check `outcome`, not just `reverted`. The last four are not failures of your
transaction and should usually not be treated as one.

`misconfigured` is the one worth alerting on. It means the workflow will keep
failing every run until someone changes the config, the secret, or the options
passed with the call, unlike `unavailable`, which usually clears by itself.

`sendTransaction` throws only for invalid arguments: a malformed transaction,
`fund` entry, state override, or `forkBlockNumber`. Everything that can go wrong
at run time comes back as a verdict, so switching on `outcome` covers every
case.

`reason` comes from the node and is passed through as text, with the Admin RPC
URL and the access key scrubbed out. Treat it as something to log, not to parse.

A disabled field is zeroed (`''`, `0n`) rather than absent, because the verdict
shape has to be stable across nodes for consensus.

## Keeping environments for inspection

`deleteEnvironment: false` keeps each node's fork instead of deleting it. Open
it in the Tenderly dashboard afterwards and you will find the funded balances and
the mined transaction in place. Each node's environment id is logged either way,
visible in the CRE dashboard's Logs tab.

Every node builds its own environment, so one execution of an eight-node workflow
leaves eight behind. On a two-minute cron that is several thousand a day, and you
will be cleaning them up by hand. Turn it on to debug something, then turn it
back off.

## What it costs to run

One environment is created per DON node, per execution, and each node spends its
own HTTP budget. DON size is not something you set, and it has varied between
runs of the same workflow, so treat the node count as a multiplier to measure
rather than assume.

Per node, per execution:

| Step | HTTP actions |
|---|---|
| create the environment | 1 |
| submit the transaction | 1 |
| read the receipt | 1 |
| delete the environment | 1 if `deleteEnvironment` |
| recover the revert reason | 1 if `explainReverts`, revert path only |
| each ERC20 `fund` entry | 1 |
| native funding, `stateOverrides` | 0 |

```ts
new TenderlyPreflight(config).httpActionCost
// 5 by default, 4 without explainReverts, 3 without deleteEnvironment too
```

That is reported, not enforced. HTTP quotas may differ between CRE tenants, so
the library does not reject a configuration against a ceiling it cannot know.
Compare it against your own `PerWorkflow.HTTPAction.CallLimit` if you are
budgeting a workflow.

Resolving a `fork.at` tag costs one EVM read against `ChainRead.CallLimit`, which
is a separate budget from HTTP actions.

## Response size

Responses are measured, and anything at or above `maxResponseBytes` is reported
as `oversized` rather than allowed to look like an outage. Receipt size grows
with log count, which you do not control, so this can happen on a legitimate
transaction with a lot of events.

Lower `maxResponseBytes` if you want to fail earlier than the platform would. It
applies to JSON-RPC responses only. Environment creation is always read up to the
platform limit, because refusing that response would leave an environment behind
that nothing knows to delete.

## Gotchas

**`z.string().url()` does not work inside a CRE workflow.** zod validates a URL
by calling `new URL(value)`, and `URL` is `undefined` in QuickJS, so every value
including a valid one is reported as invalid. If you write your own config
schema, use a regex instead.

**`gasUsed` is a median across nodes; the decision fields must agree.**
`outcome`, `reverted` and `reason` need a quorum of nodes reporting identical
values. Blocks mined on a Virtual Environment carry wall-clock timestamps, so
nodes execute at slightly different `block.timestamp` values. A contract whose
gas depends on time would otherwise fail consensus over a harmless difference. A
strongly time-dependent contract can still legitimately disagree, which comes
back as `indeterminate`. So can a revert message that embeds the timestamp or
another per-node value: set `explainReverts: false` for such a contract and
decide on `outcome` alone.

**Nothing environment-specific comes back in the verdict.** Each node has its own
fork, so its id and URLs cannot survive consensus. They are logged instead.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
bun run compile:example   # packs the library and compiles the example workflow to WASM
```

The SDK's own build-time checks (`cre-compile`'s runtime-compatibility and
determinism validators) only scan a workflow's local files, never its
dependencies, so they do not cover this package. `compile:example` runs the real
compile pipeline against the packed tarball instead, the way a user's workflow
would consume it.

### Releasing

Releases go through [Changesets](https://github.com/changesets/changesets). Add
one with your change:

```bash
bun run changeset
```

When it lands on `master`, the release workflow opens a "Release" pull request
that bumps the version and the changelog. Merging that pull request publishes
to npm with provenance.

## License

MIT
