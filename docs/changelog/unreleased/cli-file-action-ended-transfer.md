---
section: Fixed / CLI
---
- `ghostly file pause`, `resume`, `cancel`, `accept` and `decline` on a file whose transfer ended (cancelled, declined or failed) are now refused with why it ended, instead of exiting 0 and doing nothing; `accept` and `decline` on a file you sent are a usage error. `ghostly file save` of a received file that ended says so, instead of "The file is not all here yet".
