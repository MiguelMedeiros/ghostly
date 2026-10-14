---
section: Fixed / CLI
---
- `ghostly daemon --help` and `ghostly help daemon` show `daemon`'s own usage and options (`--detach`, `--timeout`) first, then the commands under it. Before, only the list of daemon commands was shown, and how long `--detach` waits was in no help. A group of one command says "1 command".
