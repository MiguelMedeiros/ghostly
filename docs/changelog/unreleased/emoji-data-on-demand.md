---
section: Fixed / Everywhere
---
- The app starts with about 400 KiB less JavaScript to load and build: the emoji list is loaded the first time an emoji panel opens (the composer's, or a reaction's +), not at every start. If it cannot be loaded, the panel says so with Try again.
