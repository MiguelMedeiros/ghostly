---
section: Fixed / CLI
---
- `invite create`'s `reason`, when no relay took the invite, is one plain line naming the relays: "No relay answered (127.0.0.1:9, 127.0.0.1:7): it goes out once one does". Before, it read "Publish failed on every relay: Error: http://127.0.0.1:9 did not answer a moment ago; retry shortly; Error: …", a JavaScript class name per relay and a "retry shortly" beside a `note` that says the invite is good.
