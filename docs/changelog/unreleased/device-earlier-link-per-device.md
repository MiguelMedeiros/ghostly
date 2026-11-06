---
section: Fixed / Devices
---
- After several device removals or new device secrets while a device of the set was off, the active device keeps one link waiting for that device, under the secret it still holds, instead of one per removal it missed. With eight removals and two devices off, it read the relays 1,080 times every 30 minutes in the background instead of 240. The device still gets the newest device set when it opens again.
