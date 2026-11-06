---
section: Fixed / CLI
---
- `chat disconnect` on a chat whose invite nobody took yet is refused the way `chat connect` is (`unavailable`, exit 1, "Nobody joined this chat yet"). It answered done with the chat at `connecting`, and with `--hold` it put the waiting invite on DHT only and could answer `pairing: error`, as if the invite had broken. `--hold 0` still ends a hold.
