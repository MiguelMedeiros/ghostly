---
section: Fixed / Apps
---
- With several stores added, the update check that runs on each visit to the Apps page starts sooner: it reads a few stores at a time instead of one after another (10 stores on a slow link: about 0.3 s instead of 1 s), and a store updated from a newer link reads that link beside its own instead of after it.
