---
section: For developers / CLI
---
- A flag that takes one of a few words, `--network`, `--wait`, `--until`, `chat request --rail` and `chat pay-request --via`, refuses any other word (or "") as a usage error (exit 2) that names the flag and lists its words, before the profile opens: `--network takes mainnet or testnet, not "weird"`. Before, the API answered it after the profile opened, with exit 1, `bad_request`, "network must be one of mainnet, testnet". The socket API keeps its own words.
