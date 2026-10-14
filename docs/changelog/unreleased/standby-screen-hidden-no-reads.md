---
section: Fixed / Devices
---
- A device on standby no longer asks its engine for the handoff twice a second and for the device set every 3 seconds while its window is hidden: about 120 calls and 20 reads of the device record a minute, for as long as the app stayed open on the device that is not in use. It asks once when the window shows again. In front, an answer that says the same no longer draws the device list again every 3 seconds. Profile, Devices on the active device does the same.
