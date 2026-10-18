---
section: Fixed / CLI
---
- `ghostly listen --webhook` whose bridge answers a 4xx or a redirect says the bridge, what it answered and that the event is passed for good (`the webhook at http://127.0.0.1:8080/hook answered 404: event 95 (message.received) passed, not taken …`), not only "the webhook did not take event 95": a wrong path or a missing token now shows in the log.
