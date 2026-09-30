---
section: Fixed / Calls
---
- The headless CLI and an app that call each other at the same moment no longer both keep calling: the earlier call rings on the other side, as between two apps. The CLI's own call ends with the reason `crossed`.
