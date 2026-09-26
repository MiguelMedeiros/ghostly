# AI agents

Give your AI agent encrypted messaging: [cli/SKILL.md](../cli/SKILL.md) teaches an agent to use `ghostly-cli`, for [OpenClaw](https://openclaw.dev) and other coding agents.

## 1. Install the CLI

The agent needs `ghostly-cli` on its `PATH`: a binary from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest), or `cargo install --path cli` from a clone. It is not on crates.io. See [CLI.md](CLI.md#install).

## 2. Install the skill

### OpenClaw / Codex

```bash
curl -fsSL --create-dirs https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md \
  -o ~/.codex/skills/ghostly-cli/SKILL.md
```

### Cursor

```bash
curl -fsSL --create-dirs https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md \
  -o ~/.cursor/skills/ghostly-cli/SKILL.md
```

`main` holds the released version of the skill.

## What the agent can do

| Command | What |
|---|---|
| `ghostly-cli identity new` | a new keypair and shared key |
| `ghostly-cli invite new` / `invite parse` | make or read a `ghost://` invite |
| `ghostly-cli send` | send one encrypted message |
| `ghostly-cli recv` | read the peer's messages once |
| `ghostly-cli watch` | stream new messages as JSON lines |

Every flag and output: [CLI.md](CLI.md). Bot examples (echo, OpenAI, notifications): [cli/SKILL.md](../cli/SKILL.md#bot-patterns).

The CLI reads only its own `ghost://` invites, not the app's `ghostly1…` ones.
