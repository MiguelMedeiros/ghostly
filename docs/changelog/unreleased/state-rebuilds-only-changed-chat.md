---
section: Fixed / Everywhere
---
- With many chats, a contact typing, setting a status, coming online, or a chat being renamed no longer rebuilds every chat for the app: only that chat is built again. Before, each such change cost time for every chat (at 2,000 chats, a change every 50 ms took about a quarter of a CPU core; now under 5%).
