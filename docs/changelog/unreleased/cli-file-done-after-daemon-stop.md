---
section: Fixed / CLI
---
- A file transfer that finishes (or fails) while its daemon is stopping, or as the daemon starts again, now gets its `file.done` (or `file.failed`) on that side when the daemon starts. Before, the file was saved but no event ever said so, so a bot that restarted its daemon while a big file arrived never handled it, and a sender waiting for `file.done` never said "sent".
