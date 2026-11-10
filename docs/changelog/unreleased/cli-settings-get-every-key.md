---
section: Fixed / CLI
---
- `ghostly settings get` (and the answer of `settings set`) now shows every key `settings set` takes, with its value in effect. A switch that is on (`sendTyping`, `autoDownloads`, `serveFiles`, `shareProfile`, `publicProfiles`) and the default Iroh and HyperDHT relays were left out, so a fresh profile showed 4 of the 11 keys and turning a switch back on made it disappear from the output.
