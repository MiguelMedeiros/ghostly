---
section: For developers / CLI
---
- `chat request --method` refuses a way of paying it does not take as a usage error (exit 2) before the profile opens, as `--rail` does: `--method takes cashu, arkade, usdt, bark, bitcoin, fedimint or spark, not "weird"`. Before, the API answered it after the profile opened, with exit 1, `bad_request`, "method must be one of cashu, arkade, usdt, bark, bitcoin, fedimint, spark".
