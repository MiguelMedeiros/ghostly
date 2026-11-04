---
section: Fixed / Identities
---
- The ID cards an open chat shows for each identity shared in it no longer draw again on every change elsewhere in the app, and neither do the identity picker, a contact's identities beside the chat, or the Identities page while they stay open. Each change, up to 20 a second while a file moves, drew every one of them again. Now each draws only when something it shows changes. In a test with 20 ID cards in a chat, 20 changes elsewhere caused no draws; before, each change drew all of them.
