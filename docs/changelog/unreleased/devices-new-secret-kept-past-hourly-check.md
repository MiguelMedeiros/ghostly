---
section: Fixed / Devices
---
- A new device secret or a removal made while the hourly check of old device addresses was running is no longer undone by that check: your other devices still get the new secret instead of staying on "moving". A device's answer that came while a new secret was being made is no longer forgotten either.
