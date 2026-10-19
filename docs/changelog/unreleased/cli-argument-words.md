---
section: Fixed / CLI
---
- An argument that takes one of a few words, given another, is a usage error (exit 2) that names it and its words, before the profile opens: `ghostly wallet create weird` says `<type> takes cashu, lightning, arkade, bark, spark, bitcoin, fedimint or usdt, not "weird"`, and so do `wallet remove`, `wallet faucet`, `wallet address`, `chat accept <chat> <method>` and `chat transport <chat> <transport>`. Before, it opened the profile and the API answered `bad_request` (exit 1) in its parameter's words, `type must be one of …`. The socket API keeps its answer.
