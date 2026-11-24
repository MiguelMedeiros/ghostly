---
section: Fixed / CLI
---
- `ghostly chat transport <chat> hyperdht` (or `iroh`) on a chat still waiting its turn after a restart now answers in about the time one listener takes to start, instead of waiting behind every other chat's listener first: with HyperDHT out of reach, 83 s with 12 chats before it said "Transport unavailable".
