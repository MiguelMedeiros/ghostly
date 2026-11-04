---
section: For developers / CLI
release: 1.10
---
- Breaking for scripts: `ghostly saved list` now answers an object with the list under `saved` (`{"saved":[...]}`),
  as every other list command does, so `jq '.saved'` reads it and a later field can be added without breaking
  callers. Before, it answered the bare array: a script reading `.[0]` now reads `.saved[0]`.
