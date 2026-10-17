---
section: Fixed / Everywhere
---
- CLI: `listen --webhook` no longer loses the events that come while its bridge is down. Each event was tried three times over about 3.5 seconds and then passed, the `--cursor` moved past it, so a bridge restarting for longer never got the events of that time, a restarted listener neither. A bridge that is not answering (connection refused, a timeout, a 5xx) now holds the stream: the event is tried again, up to a minute apart, until the bridge takes it, and stderr says so once. An event the bridge refuses with a 4xx is still passed.
