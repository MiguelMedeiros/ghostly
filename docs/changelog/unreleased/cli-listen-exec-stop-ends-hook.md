---
section: Fixed / CLI
---
- `listen --exec` stopped (SIGTERM, Ctrl-C, a service manager's restart) while its command runs now gives the command 5 s to finish, then ends it and what it started, and leaves the cursor before that event, so the next start runs it once more and never alongside the old one. Before, the command ran on by itself after the listen ended, and the restarted listen ran the same event's command again at the same time: a bot that answers with `ghostly send` sent its reply twice. A command ended by a signal is now said with it (`--exec ended by SIGKILL on event N`), not as an exit 1, and one still running after a minute is said once on stderr.
