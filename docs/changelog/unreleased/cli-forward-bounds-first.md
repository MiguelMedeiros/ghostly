---
section: Fixed / CLI
---
- `ghostly forward` reads each message once, however many times it is named, and refuses more than 30 messages or 5 chats and groups before it reads any (`bad_request`). Before, every id given was read and checked for secrets, and only then did the engine take each message once or refuse the count: the same message named 50,000 times held the daemon, and every other command, for about a minute.
