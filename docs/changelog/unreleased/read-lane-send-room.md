---
section: For developers
---
- On the read lane (`app-ranges/1`), an app's requests in flight ask for room again right before each chunk, so a native channel stays at files' line instead of filling to its budget when they all wake on one drain. A chunk the channel refuses is sent again later, as a file's is. It used to be dropped, and the contact's read never settled.
