---
section: Fixed / CLI
---
- A daemon that sends several texts at once is no longer held to the pace of one: each saved change waited for its own disk flush, one after another, on the daemon's only thread, so 8 sends in flight went no faster than 1, and every other call (`chat list`, `chat history`, `listen` events) waited behind them. The changes that come while a flush runs now share the next one, off the thread: on a test disk 8 sends in flight went from about 270 a second to about 1,000, and a read made meanwhile from 50 ms to 3 ms. Each change is still on the disk before the daemon says it is done.
