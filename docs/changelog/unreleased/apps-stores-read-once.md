---
section: For developers / Apps
---
- Behind the apps flag: opening the Apps page no longer reads each store's whole record (its list of apps, up to 4 MiB) from the device's database eight times and writes it back although nothing in it changed. The records are read once and kept, and a store is written only when its list or its state changed. A running app's next call no longer reads every store again after a check.
