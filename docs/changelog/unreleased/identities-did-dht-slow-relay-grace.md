---
section: Fixed / Identities
---
- Checking a did:dht proof no longer waits for the slowest Pkarr relay. Once one relay hands over a packet that checks out, the others get 3 seconds to offer a newer one, so a relay that hangs adds 3 seconds instead of 10 to a contact's share, Check again, the daily re-check and the add dialog's preview.
