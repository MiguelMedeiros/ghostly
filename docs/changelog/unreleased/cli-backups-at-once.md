---
section: Fixed / CLI
---
- Two `ghostly profile backup` at once through one daemon (a scheduled one and one typed by hand, or a bot's two calls on the socket) each carry their own copy of the profile. Before, they shared one working file: the first could pack the other's copy as its own, or remove it while the other still needed it, which failed.
