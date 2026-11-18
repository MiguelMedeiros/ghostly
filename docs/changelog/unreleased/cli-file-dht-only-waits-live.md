---
section: Fixed / CLI
---
- In a 1:1 chat on the DHT only (your choice, your hold, or the contact's), a `ghostly file send --wait sent` or `ghostly file wait` timeout now says that the file waits for a live session, with whose choice it is and what ends it (`ghostly chat transport <chat> auto`, once the contact chooses a live transport, or when the hold ends), and so do the wait's notice and its Ctrl-C line on a terminal. A file goes only on a live session, and these said it "still goes by itself" or waited "for a connection to the contact" when it never went until someone changed the chat's transport. A chat that holds items for the contact still says nothing of it: the file goes without a live session there.
