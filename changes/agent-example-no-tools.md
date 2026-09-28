---
section: Security / Everywhere
---
- The Claude Code agent example (`packages/cli/examples/claude-code-agent.sh`) answers each turn with no tools, no MCP servers and none of your Claude Code settings, so a contact's message can shape an answer but cannot get the agent to read a file or run a command. It keeps its conversations in `~/.local/state/ghostly-agent`, outside `~/.ghostly`, one per chat and one per member in a group, and it now also runs on macOS's own bash.
- The agents guide, the agent skill and the prompt on /developers/agents spell out the safe setup: allowlist only the owner, never a group or a community for an agent that has tools, and answer turns with a model call that has no tools.
