---
section: Fixed / CLI
---
- A daemon with many chats whose contacts are away no longer puts every chat's upkeep on the Mainline DHT every 4 minutes: those writes keep to the same per-minute share as the relays (about 40 a minute with two relays, whatever the number of chats), each chat in its turn, also while every relay is down. Before, 200 chats made about 100 DHT writes a minute for as long as the daemon ran.
