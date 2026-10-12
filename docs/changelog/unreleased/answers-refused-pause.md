---
section: Fixed / Groups
---
- A group member's connection whose answers WebRTC refused several times in a row (a race in the WebRTC library on a busy machine) is tried again after a few seconds, then over Iroh or HyperDHT, instead of waiting three minutes. Before, a member let in to a group could wait from 30 s to several minutes before it reached another member. Seen between headless Ghostly on CI.
