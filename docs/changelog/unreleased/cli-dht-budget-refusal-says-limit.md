---
section: Fixed / CLI
---
- In a chat on the DHT only, `ghostly send` of a text of about 249 to 256 bytes, or `ghostly edit` into one of about 215 bytes and up, too long for the DHT packet once sealed, now says so as the apps do: too long for the DHT, about how much fits (a text about 248 bytes, an edit about 214), and what ends it (`ghostly chat transport <chat> auto` when the DHT-only choice is yours, once the contact chooses a live transport when it is theirs, when the hold ends or with `ghostly chat connect <chat>` under `ghostly chat disconnect --hold`, or shorten it). It said only "Text and authentication exceed the DHT packet budget. Shorten the message." The error code (`refused`) and exit status (1) are unchanged.
