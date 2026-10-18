---
section: Fixed / Identities
---
- A contact's identity marks in the chat list are drawn again only when the contact's identities change. Before, every row's marks were drawn again on every change in the app, up to 20 times a second while a file moved: with 100 contacts of three identities each, 56 ms of work each time, now 11 ms.
