---
section: Fixed / Everywhere
---
- CLI: `--hold`, `--limit`, `--timeout` and `--since` out of range (`chat disconnect --hold -5`, `chat history --limit 0`, `chat wait --timeout 999999`, `send --wait sent --timeout 0`, `listen --since -1`) are now a usage error (exit 2) that names the flag and its range, before the profile opens. Before, a one-shot went online first and then failed with exit 1 in the API's words (`hold must be a number from 0 to 10080`), and `listen --since -1` printed a made-up gap and then the whole journal.
