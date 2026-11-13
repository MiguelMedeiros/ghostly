---
section: Fixed / CLI
---
- A `ghostly` command typed in a terminal while another command or the daemon's start holds the profile now says what it waits for after a second, as `--wait` does. It said nothing for up to 30 s behind a daemon that was starting (up to a minute behind commands that took the profile in turn), then answered or failed busy. Scripts and pipes still get nothing on stderr.
