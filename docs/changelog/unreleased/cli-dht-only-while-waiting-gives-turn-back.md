---
section: Fixed / CLI
---
- Right after a restart, a chat put on the DHT only (`ghostly chat transport <chat> dht`, `ghostly chat disconnect --hold`) while it still waited its turn to resume no longer keeps that turn for as long as it stays there: the chats behind it in line start. Each such chat held one of the turns for the rest of the run, and ten of them left every other chat offline until it was opened or written to.
