---
section: Fixed / CLI
---
- An amount typed as `1e3`, `0x10`, `0b11` or `0o7` is refused as a usage error (exit 2) instead of read as that number and paid: `ghostly chat pay bob 1e3` sent 1,000 sats, and a typo like `2e3` for `23` paid 2,000. `<sats>` in `chat pay`, `chat request` and `wallet receive`, and every number flag (`pay --amount`, `--max-fee` and the rest), now take only decimal digits.
