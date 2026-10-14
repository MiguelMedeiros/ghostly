---
section: For developers / CLI
---
- A daemon waits for the disk once per text it sends, where it waited nine times, and once per text it receives, where it waited twice. Each wait holds every other chat, the socket API and `listen`: about 13 of the 15 ms of a `chat.send` on a fast disk, and 100 ms on a disk that takes 10 ms per sync. The message itself is still on disk before the send answers. Its `sent` and `delivered` marks and its details go with the next write, or within a second; after a power cut a mark of the last second is made again when the daemon starts, by sending the message once more under the same id.
