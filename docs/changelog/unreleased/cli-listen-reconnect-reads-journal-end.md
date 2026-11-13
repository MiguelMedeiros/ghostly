---
section: Fixed / CLI
---
- `ghostly listen` reconnecting to a daemon, and `events --since`, read only the end of the event journal to find what came after their cursor. Each read and parsed the whole journal (up to 32 MiB): with a long journal, every reconnect held the daemon about 65 ms to return one event; now well under 1 ms.
