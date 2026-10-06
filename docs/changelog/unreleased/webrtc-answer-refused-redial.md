---
section: Fixed / Groups
---
- A chat or group member whose WebRTC connection fails just as it starts (a rare race in the CLI's WebRTC library) tries again at once. Before, it waited about 40 s, and a member let in to a group could take over a minute to reach another member.
