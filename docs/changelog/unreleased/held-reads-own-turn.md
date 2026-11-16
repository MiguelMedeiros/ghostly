---
section: Fixed
---
- With many contacts away, the app and the CLI daemon no longer ask the relays for each of them every few seconds while the relays' budget holds those reads back. A contact's read now comes back near its turn: with 200 contacts away, about 1,600 asks a minute that stay flat, where it was 2,500 at first and 4,500 after four hours, for the same reads.
