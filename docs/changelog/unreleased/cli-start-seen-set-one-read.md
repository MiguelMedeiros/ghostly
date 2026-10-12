---
section: Fixed / CLI
---
- The CLI starts faster on a profile with a long history: it reads its record of the messages already reported in two requests instead of one step per message. With 100,000 stored messages that step took about 2 seconds of every `ghostly daemon` start, and of every command run without a daemon; it now takes about a tenth of that.
