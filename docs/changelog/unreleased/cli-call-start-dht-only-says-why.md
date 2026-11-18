---
section: Fixed / CLI
---
- `call start` on a chat on DHT only (this side's choice, or the contact's) now says whose choice it is and what ends it, in the words `chat connect` uses, with `details.reason` `dht-only` or `peer-dht-only`. Before, it said the contact's app was not connected and offered `chat wait --until live`, which can never end on such a chat and failed after 60 s. Still `unavailable`, exit 1.
