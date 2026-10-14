---
section: Fixed / Apps
---
- An app that sent as fast as apps may in a chat, over a slower connection, made your own messages wait 10 to 30 seconds behind its data. An app's data now keeps to a quarter of what the connection may queue; past that `chat.send` answers `too-fast`, so messages still go at once. While a file goes in the chat, that quarter comes on top of what the file holds, so a Chess move still goes at once beside it.
