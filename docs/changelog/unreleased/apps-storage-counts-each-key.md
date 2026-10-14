---
section: Fixed / Apps
---
- An app can no longer keep far more on the device than the 5 MiB per chat it is allowed. Only the bytes of its keys and values were counted, not the roughly 140 bytes each key costs to keep, so an app that stored very many tiny values could take over 100 MiB in one chat before it was told its storage was full. Each key now counts 128 bytes more, which keeps what an app takes close to its 5 MiB. An app's data already on the device is kept as it is.
