---
section: Fixed / CLI
---
- A daemon that has kept many payments (a bot's history, or requests a contact made and settled) no longer looks at every one of them on each change: its event stream reads the payments only when one changed. At 20,000 payments each change cost about 10 ms; now nothing.
