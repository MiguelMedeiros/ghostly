---
section: Fixed / CLI
---
- Without a daemon, `ghostly call answer`, `ghostly call flush` and `ghostly service close` say at once that they need the daemon (`unavailable`, start it with `ghostly daemon --detach`), and open the profile offline. Before, each went online for 6 to 12 seconds and then said `No call is on`, `No call in chat …` or `That service is not open here` (`not_found`), though only the daemon answers calls, queues their audio and keeps a contact's app open.
