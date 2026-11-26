---
section: Fixed / CLI
---
- In a 1:1 chat on the DHT only (your choice, your hold, or the contact's), a `ghostly message delete <chat> <message> --everyone --wait confirmed` that times out now says that the removal goes only on a live session, with whose choice it is and what ends it (`ghostly chat transport <chat> auto`, once the contact chooses a live transport, or when the hold ends), and that it is given up a week after the delete. It said the removal "still goes by itself", and it never went until someone changed the chat's transport.
