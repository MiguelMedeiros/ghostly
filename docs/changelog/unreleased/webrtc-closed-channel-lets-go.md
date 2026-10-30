---
section: Fixed / CLI
---
- A direct WebRTC connection the CLI closes no longer stays in memory until the app closes. When the WebRTC library did not report the connection's channel closed, the app kept the connection, its chat or group link, and what that link held. A member of many short groups, one after another, gathered a few of them. Now the app drops its hold on the channel when it closes the connection.
