---
section: Fixed / CLI
---
- `ghostly edit` and `group edit` refusals now say what to run instead: a contact's message names the reply that answers it (`ghostly send <chat> --reply <message>`), the edit past the 100th the new message to send (`ghostly send <chat>`), and a text that reads as a join notice asks for other first words. `message delete --everyone` on one of your own messages that is already deleted says so instead of "No message … of yours", and on a contact's message says it is theirs, with the delete that takes it off this device. A 1:1 `edit` with the text the message already has answers `unchanged: true`, as `group edit` does.
