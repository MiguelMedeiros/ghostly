---
section: Fixed / CLI
---
- `chat disconnect <chat> --hold 0` now answers at once. It waited for the chat's Iroh and HyperDHT listeners to start again, 10 to 25 s when their relay or DHT was slow to reach; they now start behind it and join the chat as each comes up.
