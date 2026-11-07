---
section: Fixed / Website
---
- ghostly.tools/llms.txt no longer tells an agent that listens with `ghostly listen --turns` to wait for a `button.pressed` event, which `--turns` never delivers. Its security model now says to act only on an `agent.turn` from the owner's chat whose `press` (`{messageId, button, label}`) names the question, never on the reply's text alone. docs/CLI.md's buttons line says the same.
