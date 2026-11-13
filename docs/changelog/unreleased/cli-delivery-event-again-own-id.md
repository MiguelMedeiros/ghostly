---
section: Fixed / CLI
---
- A `message.delivery` event for a delivery a message comes back to now has an id of its own. Before, a text sent again after the contact's daemon went away before its receipt said `sent` a second time with the first `sent`'s id. A text that failed again after a retry did the same with `failed`. A listener that dedupes on `id`, as the docs ask, dropped the repeat and kept the message as still on its way. The repeat's id now ends with how many times the message's delivery changed. Every first-time id is the same as before.
