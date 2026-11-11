---
section: Fixed / CLI
---
- Holding several chats at once keeps every hold; each chat comes back to its live link when its hold ends. Before, two or more `chat disconnect --hold` sent at the same time to a daemon (parallel commands, or a bot's calls) kept only one of the holds: the other chats stayed on DHT only for good, `chat show` gave them no `heldUntil`, and `--hold 0` did not bring them back (only `chat transport auto` did). A hold that ended while another chat was being held could also come back. Removing a chat (`chat remove`) now drops its hold too, so a later backup no longer carries it and the chat's end of hold is not announced for a chat that is gone.
