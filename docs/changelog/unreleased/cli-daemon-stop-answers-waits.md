---
section: Fixed / CLI
---
- A command waiting through the daemon (`send --wait`, `edit --wait`, `react`, `pin`, `group send --wait`, a card or `button press` with `--wait`) when the daemon stops or restarts now answers `timeout` (exit 4) with what is known (a send's `messageId` and `delivery`) and `details.reason: "daemon-stopped"`: the message is kept and goes by itself. Before, it failed with `unavailable` (exit 1) "The daemon went away", and a bot that sent again sent the message twice. A request the daemon read and could not answer at all says it may be done and to check `ghostly chat history` before trying again.
