# @tenderly/cre-preflight

## 0.1.1

### Patch Changes

- 2b2ee29: Fix `region`: accepted values are now `eu` and `us-east`. The API always rejected `us`, so a config using it now fails validation instead of failing every run. `us-east` is available on some networks only.
