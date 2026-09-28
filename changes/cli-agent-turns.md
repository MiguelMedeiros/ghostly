---
section: For developers
---
- **Agent connector (experimental).** `ghostly listen --turns` gives an AI agent one `agent.turn` event per message to answer, the contact's words kept apart as untrusted data, and `--from` and `--group` are an allowlist checked before anything wakes. An example runs Claude Code on it: `packages/cli/examples/claude-code-agent.sh`.
