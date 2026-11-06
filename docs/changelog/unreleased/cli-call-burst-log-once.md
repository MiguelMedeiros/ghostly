---
section: Fixed / CLI
---
- A contact whose app places calls in a quick loop now adds one line to the daemon's log for the whole burst, and an answered call that ignores the contact's further offers says so once. Before, each of those calls added a line, and a detached daemon's `daemon.log` grew at the loop's pace.
