---
section: For developers / CLI
---
- `ghostly task remove <chat|group> <task>` and `ghostly routine remove <chat|group> <routine>` take back a card your bot sent: it goes from the chat and the Tasks board of everyone in it, and older apps show "🗑 Task removed". `ghostly task remove --all` lists every task and routine card the bot sent (in one chat or group, or everywhere), and `--all --yes` takes them all back.
