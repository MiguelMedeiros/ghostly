---
section: For developers / CI
---
- The group and community test world no longer looks up a link's other end a second time for every frame it sends. Since the world began marking links that were up, every frame walked every link of every peer twice: the 16-member group files test took 262 to 508 s in CI instead of 134 to 244, and the packages shard that runs it set every CI run's length. It now takes about 30% less CPU.
