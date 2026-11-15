---
section: Fixed / Chat
---
- Deleting several texts in a row while they wait on the DHT floor for a contact who is away no longer puts a new envelope on every relay for each delete: each deleted text still leaves the relays at once, and the text that takes its place waits a few seconds, so a burst of 10 deletes costs 2 envelopes instead of 20.
