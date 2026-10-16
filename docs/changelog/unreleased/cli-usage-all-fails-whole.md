---
section: Fixed / CLI
---
- `usage send --all` checks `--wait` and `--timeout` once, before any chat, and refuses a wrong one with `bad_request` (exit 1) as `usage send <chat>` does. When no chat takes the card, the command now fails (exit 1) instead of exiting 0, and each chat's refusal carries its `code` and `message` like every other error. Before, a wrong `--wait` or `--timeout` came back once per chat as plain text, and the run still exited 0.
