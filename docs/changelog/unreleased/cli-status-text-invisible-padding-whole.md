---
section: Fixed / CLI
---
- `status set` (and the socket's `status.set`) now keeps a status text whole when it is padded with invisible characters. A text that fit the 60 characters could lose its last ones without a word, because it was cut by its raw length before the invisible characters were taken out.
