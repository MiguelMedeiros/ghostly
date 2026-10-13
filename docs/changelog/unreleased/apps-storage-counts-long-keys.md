---
section: Fixed / Apps
---
- An app that keeps long keys can no longer take 5 to 10 times its 5 MiB per chat on the device. The device keeps each key several times over, so a key's bytes now count eight times toward the 5 MiB, and a chat full of 256-byte keys takes about 7 to 9 MB where it took 40 to 55 MB. An app's data already on the device is kept as it is.
