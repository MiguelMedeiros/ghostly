---
section: Fixed / CLI
---
- `ghostly app serve` and `ghostly app unserve` with no daemon answer at once, refusals included. They change only the profile's list of served apps, but went online first: about 10 seconds when the relays did not answer, and the contacts' apps saw this device come online.
