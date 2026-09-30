---
section: Fixed / CLI
---
- A CLI daemon no longer grows in memory for as long as it runs. It kept every storage transaction it had ever made, about 100 KB per message, and a 2 hour soak saw it grow 60 to 90 MB an hour.
