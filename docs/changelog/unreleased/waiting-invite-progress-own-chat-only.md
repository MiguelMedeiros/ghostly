---
section: Fixed / Everywhere
---
- An invite still waiting for its contact, and a chat whose contact can't be looked up, no longer rebuild every chat and group on each new attempt while the relays are out of reach (every 4 s for each waiting invite). Only that chat is rebuilt now: a CLI daemon with 40 waiting invites built about 1,700 chat views a minute while idle, and builds about 700 now.
