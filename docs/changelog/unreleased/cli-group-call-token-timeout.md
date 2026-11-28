---
section: Fixed / CLI
---
- `ghostly engine groupCallToken` says `<host> did not answer in time` when a group's call node takes the connection but never answers, with the error code `timeout` (exit 4). Before, the CLI said `Could not reach <host>` with the code `unavailable` (exit 1), as for a node that is not there. A script that retried on `unavailable` should retry on `timeout` too.
