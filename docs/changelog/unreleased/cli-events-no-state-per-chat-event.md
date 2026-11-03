---
section: Fixed / CLI
---
- A daemon with many chats spends far less CPU on each event: a message, a typing notice or a contact's app frame no longer makes it build the whole profile's state to check for a join notice. With 300 chats each event took about 3 ms, and a contact's mini-app sending 48 frames a second cost about 15% of a core; it is now about 1 µs an event.
