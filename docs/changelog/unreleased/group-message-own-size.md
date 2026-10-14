---
section: Fixed / Groups
---
- A message received in a private group now writes about its own size to the device. The group's record no longer holds the last 256 messages kept for members who were away (60 to 260 KiB, written again for every message, most of what a busy CLI daemon wrote to disk): each is kept with its own message. A group from before keeps handing on what its record held, which leaves it as newer messages come.
