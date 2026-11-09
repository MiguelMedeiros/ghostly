---
section: Fixed / Chat
---
- A text sent over the DHT that was still waiting for its receipt when the app closed no longer shows "sent" for an hour after the app opens again when the device clock was set back an hour in between (or a clock that ran ahead was set right). It waits for its receipt for at most its usual five minutes from the restart. After a clock change of more than about 25 days, such a text is also no longer marked failed right at start while it is still going out.
