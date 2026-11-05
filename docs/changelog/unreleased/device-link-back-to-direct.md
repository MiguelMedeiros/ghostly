---
section: Fixed / Devices
---
- A device link that went on through Iroh's relay, where only one of the two devices could start on it, now tries the direct connection again after a while (one minute at first, longer each time, up to five). Before, the two devices stayed unlinked until one of them restarted, even once the direct connection would work.
