---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: with three apps or more running at once, an app reading one of its own files no longer reads its whole bundle (up to 16 MiB) back and checks it again. The engine kept the checked bundles of two apps only, so each read pushed out the one the next app needed: a 2-byte or missing file cost 18 ms of reading and hashing. Now each running app that used its files in the last minute keeps its checked bundle, and a read takes well under a millisecond; a closed app's bundle leaves memory a minute after its last use once two newer ones are kept, also while another app keeps running and reading only its own files.
