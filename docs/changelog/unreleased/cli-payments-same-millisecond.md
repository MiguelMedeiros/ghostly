---
section: Fixed / CLI
---
- Payments and requests a bot makes at once (`chat pay` or `chat request` run in parallel, or many requests on the daemon's socket) are each their own message in its chat. Before, two of them made in the same millisecond, or one of them and a file sent then, shared one message: the sender's chat kept only one of them.
