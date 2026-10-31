---
section: Fixed / CLI
---
- `service open --port` says what is wrong with the port: out of range or not whole is a usage error before the profile opens, and a port in use or not allowed is named with the way out. On a service already open, asking for another port is refused and names the port it is on. Before, that answered exit 0 with a link on the other port, a port in use was Node's own error, and a port not allowed read "Not allowed to write or read the path".
