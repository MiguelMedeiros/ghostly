---
section: Fixed / CLI
release: 1.14
---
- A connection to the daemon's socket has at most 1,024 calls open at once: the next is refused with `busy` until one answers, and other connections are not held to it. A program that wrote calls without reading their answers had no limit, and each open wait held memory in the daemon (204 MB with 100,000 `chat wait`s on one connection).
