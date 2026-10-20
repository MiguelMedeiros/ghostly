---
section: Fixed / CLI
---
- A daemon that is busy for more than 10 seconds (a long backlog after a lost connection) no longer has every command and `listen` refused as "a daemon of an older release" with the advice to restart it: they wait for it as 1.4 did, each under its own deadline, and `daemon stop` waits for it too instead of killing it. A daemon of a release before 1.5.0 is now told apart in 2 seconds instead of 10.
