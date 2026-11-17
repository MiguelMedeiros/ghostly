---
section: Fixed / CLI
release: 1.14
---
- `identity add <provider>` without the subject the provider takes (`identity add ssh`, `identity add did`) is now a usage error (exit 2), as a missing provider or a missing signer field already was. Before, it was `bad_request` (exit 1).
- `identity add pubky --timeout 900` is now a usage error (exit 2) naming `--timeout` and Pubky's own range: "--timeout takes a number of seconds from 5 to 300 for Pubky Ring or Pubky Passport (it waits at most 300 s for an approval), not 900". Before, it was `bad_request` (exit 1) in the API's words, "timeout must be a number from 5 to 300".
