---
section: Fixed / CLI
---
- A command on a daemon that has stopped answering no longer waits for ever. A read or `daemon status` gives up after 15 seconds (`daemon status --timeout s` sets its own), a command that waits for the contact (`chat wait`, `file wait`, `--wait`) after its `--timeout` (or the default: 60, 300 and 30 s) plus 10 seconds, with code `timeout` (exit 4), `details.method` and the way out: `ghostly daemon restart`, which ends a daemon that does not answer `daemon stop` (SIGTERM, then SIGKILL) and starts a fresh one. A bot following the agent guide could otherwise hang at `chat wait` or `send` and never reach the next step. A long-running send, a subscription (`listen`) and `identity add` still take as long as they need.
