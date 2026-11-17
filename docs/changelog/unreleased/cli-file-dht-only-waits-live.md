---
section: Fixed / CLI
---
- In a 1:1 chat on the DHT only (your choice, your hold, or the contact's), `ghostly file send` now says that the file waits for a live session, with whose choice it is and what ends it (`ghostly chat transport <chat> auto`, once the contact chooses a live transport, or when the hold ends): in a `note` on the answer, in the words and `details.note` of a `--wait sent` or `ghostly file wait` timeout, and in the wait's notice and Ctrl-C line on a terminal. `ghostly file list` gives the waiting file that `note`, and `waitingFor: "me"` when it is your choice. A file goes only on a live session, and these said it "still goes by itself" or waited "for a connection to the contact" when it never went until someone changed the chat's transport.
