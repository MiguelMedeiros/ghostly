---
section: Fixed / CLI
---
- Ctrl-C on a `ghostly file send` that waits for the contact (`--wait sent`, or a one-shot with no daemon running) no longer says the file is kept and still goes while the file is still being copied into the profile. Ctrl-C there stops the send and nothing is in the chat. The line now says that the send stops while the file is copied in and only the waiting stops after, and names `ghostly file list <chat>` to see which it was.
