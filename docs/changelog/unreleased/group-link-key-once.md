---
section: Fixed / Groups
---
- The admin of a private group with a link spent a key derivation for each such group every time the app's state was built (up to 20 times a second): about an eighth of a busy CLI daemon's time. The link's key is now derived once, when the link is made or replaced.
