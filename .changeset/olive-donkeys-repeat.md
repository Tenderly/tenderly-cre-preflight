---
"@tenderly/cre-preflight": patch
---

Fix the `region` enum: the accepted values are `eu` and `us-east`.

`region` was typed `'us' | 'eu'`. The API rejects `us` with
`region is invalid`, so a config setting it parsed cleanly and then failed on
every single run with a `misconfigured` verdict. The value that does work,
`us-east`, was not in the enum at all, so there was no way to select a US
region through the library.

Verified against the live API on ethereum, base, arbitrum, polygon and sepolia:
`eu` and `us-east` are accepted on all of them and the choice appears in the
Admin RPC hostname (`virtual.mainnet.us-east.rpc.tenderly.co`).
