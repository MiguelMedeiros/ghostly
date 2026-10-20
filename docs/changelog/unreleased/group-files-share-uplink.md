---
section: Fixed / Groups
---
- A member serving a group file to several members at once on a slow uplink no longer holds everything else it sends behind the files: the members it serves share one floor for what may be in flight, and read the queue against the shortest round trip any of them saw. At 1 Mbit/s with three members fetching a 2 MiB picture, its texts went from about 1.5 s behind to about 0.65 s, and the files take as long as before.
