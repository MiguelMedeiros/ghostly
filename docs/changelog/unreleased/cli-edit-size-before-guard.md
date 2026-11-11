---
section: Fixed / CLI
---
- `ghostly edit` and `ghostly group edit` refuse a text over 16 KiB at once, as `send` does (`bad_request`: "Message exceeds 16384 UTF-8 bytes"). Before, the secret check read the whole text first: an edit of a few megabytes (`--stdin`, or the socket) held the daemon and every other command for up to two seconds before the engine refused it (`refused`), and one of 9 MB failed with "Maximum call stack size exceeded".
