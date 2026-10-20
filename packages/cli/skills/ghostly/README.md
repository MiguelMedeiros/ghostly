# Ghostly skill: an AI agent talks to its owner

A skill for AI coding agents: the owner messages the agent from the Ghostly app, and the agent answers, asks with
buttons, reacts and shows what it is doing. It takes instructions from the owner's chat only.

- [SKILL.md](SKILL.md): what the agent reads (setup, the loop, the security rules).
- [scripts/](scripts): `listen`, `say`, `status` and `react`, in POSIX `sh`. They need the `ghostly` CLI
  (`npm install -g @ghostlytools/cli`, Node 22.12 or newer), `jq`, and `GHOSTLY_OWNER_CHAT` set to the owner's chat id.

## Install in Claude Code

Copy this folder to `~/.claude/skills/ghostly` (or `.claude/skills/ghostly` in a project):

```bash
git clone --depth 1 https://github.com/MiguelMedeiros/ghostly /tmp/ghostly-src
mkdir -p ~/.claude/skills && cp -R /tmp/ghostly-src/packages/cli/skills/ghostly ~/.claude/skills/ghostly
rm -rf /tmp/ghostly-src
```

Or put it in a plugin's `skills/` folder to share it with a team. It is named `ghostly`, as is the CLI's own skill
([../../SKILL.md](../../SKILL.md)), so install one of them under that name: this one for an agent that talks to its
owner, the CLI's for a bot that answers other people.

Then ask Claude Code to set it up: "Use the ghostly skill and pair with me". It installs the CLI, starts the daemon
and waits for the invite link you make in the Ghostly app.

## Other agents

The scripts depend on nothing from Claude Code. Any agent with a shell (Codex, Cursor, a custom one) can run them by
path or from `PATH`, and read [SKILL.md](SKILL.md) as its instructions:

```bash
export GHOSTLY_OWNER_CHAT=<chat id>
scripts/listen --once                                  # the owner's next message, as JSON
scripts/react <messageId>                              # 👀
scripts/status "Running the tests"                     # "thinking" with a status
scripts/say --reply <messageId> "All green."           # the answer
```

The tests are in [../../test/ownerSkill.test.ts](../../test/ownerSkill.test.ts): every script against a fake
`ghostly` on `PATH`.
