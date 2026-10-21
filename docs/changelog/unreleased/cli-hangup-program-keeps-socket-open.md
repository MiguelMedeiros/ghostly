---
section: Fixed / Calls
---
- In the CLI, a hang-up reaches the contact at once even when the bot's program keeps its audio socket open after the call ends. Before, `call hangup` waited 2 seconds and the contact heard silence on a call that still said connected for 2 to 4 seconds.
