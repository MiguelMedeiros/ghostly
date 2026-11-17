---
section: Fixed / CLI
---
- In a 1:1 chat on the DHT only (your choice, your hold, or the contact's), `ghostly pin` and `ghostly pin --remove` now say that the pin waits for a live session, with whose choice it is and what ends it (`ghostly chat transport <chat> auto`, once the contact chooses a live transport, or when the hold ends): in a `note` on the answer, and in the words and `details.note` of a `--wait confirmed` timeout. A pin goes only on a live session, and the timeout said it "still goes by itself" when it never went until someone changed the chat's transport.
- `ghostly pin <chat> <message> --remove` is now refused as a usage error (exit 2): `--remove` names no message and unpins whatever is pinned, so a script that meant "unpin this message" could unpin another one.
- A timed-out `ghostly pin` or `ghostly react` now carries the message in its `details` (`messageId`, and `emoji` for `react`, `removed` for `pin`), as `edit` and `message delete` already did.
