---
"@tenderly/cre-preflight": patch
---

Fix `region`: accepted values are now `eu` and `us-east`. The API always rejected `us`, so a config using it now fails validation instead of failing every run. `us-east` is available on some networks only.
