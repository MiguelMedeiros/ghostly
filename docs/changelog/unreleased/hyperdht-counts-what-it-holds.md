---
section: Fixed / Chat
---
- On a slow connection over HyperDHT (Desktop and the CLI), a message sent while a file was going waited behind the whole file: the app never saw how much the connection still held, so it handed over the file as fast as it could read it. It now waits for the connection as it does on the others, and a message goes through in a fraction of a second (7.3 s before, in a test with a contact that reads at about 4 MB/s).
