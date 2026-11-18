---
section: Fixed / CLI
---
- `ghostly help file accept` now says the file is refused when it does not fit in the room left on the device (it keeps waiting), and `ghostly help identity add` gives `--timeout`'s default and range (300 s, 5 to 3600, Pubky at most 300). The CLI's README no longer says a too-long edit in a DHT-only chat waits: it is refused, as the CLI does.
