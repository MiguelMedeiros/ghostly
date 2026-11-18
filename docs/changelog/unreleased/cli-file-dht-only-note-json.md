---
section: Changed / CLI
---
- In a 1:1 chat on the DHT only, `ghostly file send --json` answers a `note` saying that the file waits for a live session, whose choice it is and what ends it; a `--wait sent` or `ghostly file wait` timeout carries it as `details.note`, and `ghostly file list` gives the waiting file that `note` with `waitingFor: "me"` when it is your choice (`"contact"` when it is theirs). A chat that holds items for the contact sends the file without a live session and says none of it.
