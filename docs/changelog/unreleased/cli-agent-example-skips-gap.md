---
section: Fixed / CLI
---
- The Claude Code agent example (`examples/claude-code-agent.sh`) no longer treats an `events.gap` from `listen --turns` as a turn. It ran `claude` on it and then tried to reply in no chat; it now says on stderr which events were lost and goes on.
