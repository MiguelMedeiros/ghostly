---
section: Fixed / CLI
---
- A call's daemon no longer decodes the contact's silence again for every packet while it lasts: once the same packet gave the same audio twice in a row, that audio is handed on again. What the program hears is the same, byte for byte, and a quiet call takes about half the work it did on the daemon's thread.
