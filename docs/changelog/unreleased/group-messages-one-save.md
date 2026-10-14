---
section: Fixed / Groups
---
- A private group no longer writes its whole record to the device for every message received. Messages that arrive together (someone back in a busy group taking 250 of them, a lively conversation) are now one write a second at most: the record holds the last 256 messages kept for members who were away, 100 to 260 KiB each time, so a catch-up wrote tens of megabytes and held the CLI for seconds.
