---
section: Fixed / Everywhere
---
- When one discovery relay takes connections but never answers, a new device's first pairing no longer waits on it: it took about 8 seconds instead of 2.5, and now takes about as long as with every relay answering. A relay that has left a request unanswered for a moment is asked after the others.
