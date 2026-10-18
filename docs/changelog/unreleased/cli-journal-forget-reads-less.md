---
section: Fixed / CLI
---
- A message deleted on a CLI profile (by you, or by a contact deleting theirs for everyone) takes its events out of the event journal without reading the whole journal as text: the journal is searched for the message and read from its first event on, and one it no longer names is not written again. With 10,000 events, deleting a recent message held the daemon 27 ms, now 9 ms, and one change that deletes 2,000 messages 11.6 s, now 80 ms.
