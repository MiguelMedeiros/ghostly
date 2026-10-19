---
section: For developers / CLI
---
- A command's argument that takes one of a few words, `wallet create|remove|faucet <type>`, `wallet address <type>`, `chat accept <chat> <method>` and `chat transport <chat> <transport>`, and `chat request --method`, refuses any other word as a usage error (exit 2) that names it and lists its words, before the profile opens: `<type> takes cashu, lightning, arkade, bark, spark, bitcoin, fedimint or usdt, not "weird"`. Before, the API answered it after the profile opened, with exit 1, `bad_request`, "type must be one of …". The socket API keeps its own words.
