---
section: Fixed / Everywhere
---
- A discovery packet that every relay's request budget holds back is no longer signed first: the app (and a CLI daemon on a private network's relays) says the wait before it signs, so a busy profile at its budget no longer spends CPU on packets that never go out. A CLI daemon with the Mainline DHT still signs them, as the DHT takes them anyway.
