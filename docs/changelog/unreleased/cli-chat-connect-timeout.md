---
section: Fixed / CLI
---
- `chat connect` takes `--timeout` (1 to 90 s; 90 by default, as before). When the contact does not answer, it now says what happens next: a one-shot tells you to try again later or keep the profile online with `ghostly daemon --detach`, a daemon that it reconnects by itself and that `ghostly chat wait <chat> --until live` waits for it. Before, it always waited 90 s and ended "Timed out connecting to the peer".
