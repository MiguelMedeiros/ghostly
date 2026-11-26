---
section: For developers
---
- A blocked contact's 1:1 chat says it cannot call (`callsUnavailable`: "You blocked this contact. Unblock them to call"), so the app's call buttons and the CLI's `call start` and `call answer` refuse it. Its answer would be dropped like everything else it sends: a call placed to it rang its app and never connected.
