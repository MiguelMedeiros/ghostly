---
section: Fixed / CLI
---
- `ghostly call answer`, `call flush`, `call hangup` and `call pipe` given an empty or blank `<chat|call>` (an unset variable in a script: `ghostly call hangup "$CALL"`) now refuse it as a usage error (exit 2) before reaching the daemon. It was read as left out, so it hung up, declined, answered or flushed whatever call was on. Leaving the call out still means the only call.
