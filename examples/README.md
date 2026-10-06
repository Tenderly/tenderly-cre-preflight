# Examples

Not published with the package.

## `preflight-workflow/`

A cron workflow that sends a transaction on a Tenderly Virtual Environment and
skips the on-chain write when it would fail.

Three files, meant to be copied into a CRE project rather than run from here:

| File | Goes to |
|---|---|
| `workflow.ts` | your workflow's entry point |
| `config.json` | your workflow's config, with your own account and project slugs |
| `secrets.yaml` | your project root |

```bash
cre init my-workflow
cp examples/preflight-workflow/workflow.ts  my-workflow/main.ts
cp examples/preflight-workflow/config.json  my-workflow/config.json
cp examples/preflight-workflow/secrets.yaml my-workflow/../secrets.yaml

# put your Tenderly access key in the Vault under the name config.json expects
export TENDERLY_ACCESS_KEY=...
cre secrets create

cre workflow simulate my-workflow --target local --non-interactive --trigger-index 0
```

Edit `config.json` first: `accountSlug` and `projectSlug` must be yours, and the
`transaction` block is a placeholder.
