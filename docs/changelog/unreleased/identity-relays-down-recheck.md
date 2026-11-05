---
section: Fixed / Identities
---
- A contact's proof no longer turns unconfirmed when the app checks it again on its own and the check could not run: no Pkarr relay answering for a Pubky or did:dht proof, or servers that hang until the check runs out of time. That is this side's network, so the proof stays as it was and is tried again later, as for a domain whose server could not be reached.
