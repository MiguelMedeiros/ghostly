---
section: Fixed / CLI
---
- A CLI call always ends when it is hung up, even when its audio codec fails as it closes: the contact is told, the program reads the end of its audio, `call.ended` goes out and the connection closes. Before, such a failure stopped the end halfway and the call stayed open on both sides.
