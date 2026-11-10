---
section: Fixed / CLI
---
- Two `daemon --detach` started together with a `daemon stop`: the detach whose daemon took the profile read the other one's "busy" answer in `daemon.log` as its own, and when the stop ended its daemon it started a second one right after the stop answered "stopped". A detach now reads only its own daemon's answer, and a daemon that was stopped is not started again.
