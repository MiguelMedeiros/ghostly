---
section: Fixed / Groups
---
- A new group takes the same names a rename does: up to 64 characters on one line, a new line read as a space. A longer name is refused with the reason (`ghostly group create` answers `bad_request`) instead of being cut at 48 without a word, sometimes through an emoji.
