---
section: Fixed / CLI
---
- CLI calls: a program on a call's audio socket that another program replaced, and that kept its side open, is let go 2 s later. It held its connection until it exited, and a daemon stopped during that call waited on it until the stop gave up after 20 s.
