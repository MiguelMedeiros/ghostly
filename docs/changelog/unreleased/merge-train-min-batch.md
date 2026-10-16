---
section: For developers
---
- The merge train waits for company: a batch leaves once 3 pull requests can board, or once the first has waited 15 minutes, or at once for `queue:priority`, so fewer full CI runs land more pull requests. The train's schedule runs every 5 minutes.
