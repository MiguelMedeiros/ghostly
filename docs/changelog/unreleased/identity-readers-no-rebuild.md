---
section: Fixed / Identities
---
- A contact's identities beside the chat, Identities → From your contacts and the chat list no longer build an entry for every chat and compare them all on each change of the app's state (up to 20 a second while a file moves) only to find nothing changed: each chat's entry is built once and kept while its chat is unchanged, and the three share one list per state (with 2,000 chats, up to about 1 ms less work on each change while a contact's identities or the Identities page are open, and about 0.2 ms always).
