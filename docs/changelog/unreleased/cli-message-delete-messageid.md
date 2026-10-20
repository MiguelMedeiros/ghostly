---
section: Fixed / CLI
---
- `ghostly message delete` now returns the deleted message's id as `messageId`, like every other command that sends or changes a message, plus `everyone: false` when the message is deleted only on this device. The old `deleted` key still holds the same id.
