---
section: Fixed / CLI
---
- A daemon's `ghostly status` says how each Pkarr relay is doing (`discovery.health`: ok, throttled or failing, and until when) and where its last read went (`discovery.via`: relay or DHT). With every relay down it used to read the same as with them all fine.
