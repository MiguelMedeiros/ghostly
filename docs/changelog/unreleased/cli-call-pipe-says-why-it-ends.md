---
section: Fixed / CLI
---
- `ghostly call pipe` says on stderr why it stops: "the call ended" with the reason `call.ended` gives (`hangup`, `remote-hangup`, `rejected`, `missed`, `failed`, `stopped`…), or "another program took its audio; the call goes on". Before, all of these ended with exit 0 and no message, so a contact hanging up looked the same as a second `call pipe` taking over the call.
