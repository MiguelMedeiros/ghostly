---
section: Fixed / CLI
---
- A daemon whose WebRTC contacts have all gone away no longer wakes about 100 times a second. The WebRTC library's threads started with the first connection and stayed for as long as the daemon ran, even with no connection left. They now stop a minute after the last connection closes, and start again with the next one: an idle daemon went from about 107 wakeups a second to about 6.
