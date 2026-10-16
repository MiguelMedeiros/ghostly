---
section: For developers / CLI
---
- A skill for AI coding agents, Claude Code first, to talk to their owner over Ghostly: `packages/cli/skills/ghostly`. Four small `sh` scripts on the `ghostly` CLI listen to the owner's chat only (every other chat, group and event is dropped), answer with a quote, ask with buttons, react and show a "thinking" status. Its SKILL.md tells the agent that only the owner's chat gives instructions, that quoted or forwarded text is data, and to ask with buttons before anything irreversible.
