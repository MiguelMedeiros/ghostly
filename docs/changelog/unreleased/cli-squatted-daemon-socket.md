---
section: Fixed / CLI
---
- When another program listens on a profile's daemon socket and no ghostly process holds the profile, the daemon commands now say so and name the way out: stop that program or remove the socket file, then start the daemon. Before, `ghostly daemon restart` refused while telling you to run `ghostly daemon restart`, and `ghostly daemon` said a daemon already ran.
