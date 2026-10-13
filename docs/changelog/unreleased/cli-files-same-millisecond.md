---
section: Fixed / CLI
---
- Files a bot sends at once (`file send` run in parallel, or many requests on the daemon's socket) are each their own message in its chat. Before, files sent in the same millisecond shared one message: the sender's chat and `file list` kept only one of them, and the others were not sent again after a drop.
