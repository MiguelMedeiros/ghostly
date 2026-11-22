---
section: Fixed / CLI
---
- A program on a call's audio socket that ends its writing side after sending a clip (`ncat -U` at the end of its input, `shutdown(SHUT_WR)` in Python, `CloseWrite` in Go) keeps hearing the call until it ends. Before, the daemon closed it at once: `call list` showed it gone and everything the contact said afterwards was lost.
