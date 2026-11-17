---
section: Fixed / CLI
---
- A group join through a link nobody answers now says the link may have been replaced or turned off, and to ask for the current one, as the app does after 2 minutes. The one-shot `group join` only said to keep a daemon running, which knocks for an hour at a link nobody reads, and `group show` stayed at stage `knocked` with no word; it now also gives when the knock started (`since`).
