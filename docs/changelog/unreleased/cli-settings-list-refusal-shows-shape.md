---
section: Fixed / CLI
---
- `ghostly settings set iceServers` given a list of addresses (`'["stun:host:3478"]'`) or one server alone says each server is an object and shows one, `'[{"urls":"stun:stun.example.org:3478"}]'`; `relays` and `irohRelays` given an address alone show a list of them. Before, the refusal read "takes a JSON list of ICE servers" to a person who had just given one.
