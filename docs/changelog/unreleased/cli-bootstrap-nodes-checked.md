---
section: Fixed / CLI
---
- `GHOSTLY_DHT_BOOTSTRAP` and `GHOSTLY_HYPERDHT_BOOTSTRAP` are checked: a node without a port, a port past 65535 or a `;` between nodes made every command die with Node's raw stack and no JSON answer, and `udp://…`, an IPv6 node or nodes split by spaces left the profile with no DHT, saying nothing. Each is now a usage error naming the variable and the node. Two `GHOSTLY_PKARR_RELAYS` split by `;` or a space, once taken as one URL, are refused the same way.
